import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/mock-utils";
import { E19_CLINICAL_POLICY } from "@veriarfy/study";

const panelId = ethers.id(E19_CLINICAL_POLICY.panelId);
const purposeId = ethers.id(E19_CLINICAL_POLICY.purposeId);
const consentVersion = ethers.id(E19_CLINICAL_POLICY.consentVersion);
const panelHash = ethers.id(E19_CLINICAL_POLICY.panelDocumentId);
const documentHash = ethers.id(E19_CLINICAL_POLICY.consentDocumentId);
const endpoint = ethers.id("synthetic-clopidogrel-response-v1");
const maxDuration = BigInt(E19_CLINICAL_POLICY.maximumConsentDays) * 24n * 60n * 60n;

describe("E/19 encrypted clinical aggregate profile", () => {
  async function fixture() {
    const [owner, researcher, node, ...participants] = await ethers.getSigners();
    const Protocol = await ethers.getContractFactory("VeriarfyProtocolE19");
    const protocol = await Protocol.deploy(await owner.getAddress(), 1);
    const Registry = await ethers.getContractFactory("ClinicalRegistryHarness");
    const registry = await Registry.deploy();
    const Consent = await ethers.getContractFactory("VeriarfyClinical");
    const consent = await Consent.deploy(await protocol.getAddress(), await registry.getAddress());
    const Stats = await ethers.getContractFactory("ClinicalResponseStats");
    const stats = await Stats.deploy();
    const Aggregate = await ethers.getContractFactory("VeriarfyClinicalAggregate", { libraries: { ClinicalResponseStats: await stats.getAddress() } });
    const aggregate = await Aggregate.deploy(await protocol.getAddress(), await consent.getAddress(), panelId, purposeId);
    await protocol.setClinicalModule(await aggregate.getAddress());
    await protocol.setQueryGateway(await owner.getAddress());
    await protocol.authorizeNode(await node.getAddress());
    await registry.setRegistered(await researcher.getAddress(), true);
    await consent.configurePolicy({ panelId, purposeId, consentVersion, panelHash, consentDocumentHash: documentHash, maxConsentDuration: maxDuration, panelUri: E19_CLINICAL_POLICY.panelUri });
    await aggregate.configureEndpoints([endpoint], panelHash, E19_CLINICAL_POLICY.panelUri);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    return { owner, researcher, node, participants, protocol, consent, aggregate, now };
  }

  async function contribute(f: Awaited<ReturnType<typeof fixture>>, index: number, group: number, response: number) {
    const participant = f.participants[index];
    const participantAddress = await participant.getAddress();
    const protocolAddress = await f.protocol.getAddress();
    const aggregateAddress = await f.aggregate.getAddress();
    const encryptedGroup = await fhevm.createEncryptedInput(protocolAddress, participantAddress).add8(group).encrypt();
    await f.protocol.connect(participant).enroll(encryptedGroup.handles[0], encryptedGroup.inputProof);
    await f.consent.connect(participant).acceptConsent(panelId, purposeId, consentVersion, documentHash, f.now + 1_000_000n);
    const encryptedResponse = await fhevm.createEncryptedInput(aggregateAddress, participantAddress).add8(response).encrypt();
    await f.aggregate.connect(participant).contributeResponses(encryptedResponse.handles, encryptedResponse.inputProof);
  }

  async function release(f: Awaited<ReturnType<typeof fixture>>) {
    await f.protocol.requestAggregate(await f.researcher.getAddress());
    await f.protocol.connect(f.node).approveAggregate(0);
    await f.protocol.executeAggregate(0);
  }

  async function decrypt(f: Awaited<ReturnType<typeof fixture>>, group: number, response: number) {
    const handle = await f.aggregate.disclosureResponseAt(0, 0, group, response);
    return Number(await fhevm.userDecryptEuint(FhevmType.euint32, handle, await f.aggregate.getAddress(), f.researcher));
  }

  it("enforces consent and releases only the eligible immutable 30+30 / 2x2 aggregate", async function () {
    this.timeout(180_000);
    const f = await fixture();
    for (let index = 0; index < 60; index++) await contribute(f, index, index < 30 ? 0 : 1, index % 30 < 15 ? 0 : 1);
    await release(f);
    expect(await f.protocol.participantCount()).to.equal(60n);
    expect([await decrypt(f, 0, 0), await decrypt(f, 0, 1), await decrypt(f, 1, 0), await decrypt(f, 1, 1)]).to.deep.equal([15, 15, 15, 15]);
    const raw = await f.aggregate.responseAggregate(0, 0, 0);
    await expect(fhevm.userDecryptEuint(FhevmType.euint32, raw, await f.aggregate.getAddress(), f.researcher)).to.be.rejected;
    await expect(f.protocol.requestAggregate(await f.researcher.getAddress())).to.be.revertedWithCustomError(f.protocol, "E19AlreadyRequested");
  });

  it("masks all four cells when any clinical response cell is below five", async function () {
    this.timeout(180_000);
    const f = await fixture();
    for (let index = 0; index < 60; index++) {
      const group = index < 30 ? 0 : 1;
      const withinGroup = index % 30;
      await contribute(f, index, group, group === 1 && withinGroup < 4 ? 0 : 1);
    }
    await release(f);
    expect([await decrypt(f, 0, 0), await decrypt(f, 0, 1), await decrypt(f, 1, 0), await decrypt(f, 1, 1)]).to.deep.equal([0, 0, 0, 0]);
  });
});
