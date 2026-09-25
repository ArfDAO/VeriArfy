import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { E19_CLINICAL_POLICY } from "@veriarfy/study";

const panelId = ethers.id(E19_CLINICAL_POLICY.panelId);
const purposeId = ethers.id(E19_CLINICAL_POLICY.purposeId);
const consentVersion = ethers.id(E19_CLINICAL_POLICY.consentVersion);
const panelHash = ethers.id(E19_CLINICAL_POLICY.panelDocumentId);
const documentHash = ethers.id(E19_CLINICAL_POLICY.consentDocumentId);
const endpoint = ethers.id("synthetic-clopidogrel-response-v1");
const maxDuration = BigInt(E19_CLINICAL_POLICY.maximumConsentDays) * 24n * 60n * 60n;

describe("E/19 payment adapter + encrypted clinical profile", () => {
  it("holds the field-priced payment until the real E/19 FHE aggregate is granted", async function () {
    this.timeout(180_000);
    const [owner, researcher, node, ...participants] = await ethers.getSigners();
    const Protocol = await ethers.getContractFactory("VeriarfyProtocolE19");
    const protocol = await Protocol.deploy(await owner.getAddress(), 1);
    const Registry = await ethers.getContractFactory("ClinicalRegistryHarness");
    const registry = await Registry.deploy();
    const Consent = await ethers.getContractFactory("VeriarfyClinical");
    const consent = await Consent.deploy(await protocol.getAddress(), await registry.getAddress());
    const Stats = await ethers.getContractFactory("ClinicalResponseStats");
    const stats = await Stats.deploy();
    const Aggregate = await ethers.getContractFactory("VeriarfyClinicalAggregate", {
      libraries: { ClinicalResponseStats: await stats.getAddress() },
    });
    const aggregate = await Aggregate.deploy(await protocol.getAddress(), await consent.getAddress(), panelId, purposeId);
    const Token = await ethers.getContractFactory("StableTestToken");
    const token = await Token.deploy(await owner.getAddress());
    const Payments = await ethers.getContractFactory("VeriarfyE19Payments");
    const payments = await Payments.deploy(
      await owner.getAddress(),
      await protocol.getAddress(),
      await aggregate.getAddress(),
      await token.getAddress(),
      await registry.getAddress(),
      100,
      10,
      8_000,
      50_000,
    );

    await protocol.setClinicalModule(await aggregate.getAddress());
    await protocol.setQueryGateway(await payments.getAddress());
    await protocol.authorizeNode(await node.getAddress());
    await registry.setRegistered(await researcher.getAddress(), true);
    await consent.configurePolicy({ panelId, purposeId, consentVersion, panelHash, consentDocumentHash: documentHash, maxConsentDuration: maxDuration, panelUri: E19_CLINICAL_POLICY.panelUri });
    await aggregate.configureEndpoints([endpoint], panelHash, E19_CLINICAL_POLICY.panelUri);
    await token.mint(await researcher.getAddress(), 1_000);
    await token.connect(researcher).approve(await payments.getAddress(), ethers.MaxUint256);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);

    for (let index = 0; index < 60; index++) {
      const participant = participants[index];
      const participantAddress = await participant.getAddress();
      const encryptedGroup = await fhevm.createEncryptedInput(await protocol.getAddress(), participantAddress).add8(index < 30 ? 0 : 1).encrypt();
      await protocol.connect(participant).enroll(encryptedGroup.handles[0], encryptedGroup.inputProof);
      await consent.connect(participant).acceptConsent(panelId, purposeId, consentVersion, documentHash, now + 1_000_000n);
      const encryptedResponse = await fhevm.createEncryptedInput(await aggregate.getAddress(), participantAddress).add8(index % 2).encrypt();
      await aggregate.connect(participant).contributeResponses(encryptedResponse.handles, encryptedResponse.inputProof);
    }

    // 60 kayit x 10 + 100 taban = 700; herkes kapsadigi tek endpoint icin ayni agirlikta.
    expect(await payments.quote()).to.deep.equal([700n, 60n, 600_000n]);
    await payments.connect(researcher).openQuery();
    await expect(payments.settleQuery()).to.be.revertedWithCustomError(payments, "OutputNotGranted");

    await protocol.connect(node).approveAggregate(0);
    await protocol.executeAggregate(0);
    await payments.settleQuery();
    expect(await payments.claimable(await participants[0].getAddress())).to.equal(9n);
    await expect(payments.connect(participants[0]).claim())
      .to.emit(payments, "RewardClaimed")
      .withArgs(0, await participants[0].getAddress(), 9n);
  });
});
