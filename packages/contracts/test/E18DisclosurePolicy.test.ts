import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/mock-utils";
import {
  e18PlaintextReference,
  makeE18SyntheticCohort,
} from "@veriarfy/study";
import { biomarkersFactory, protocolFactory } from "./helpers/factories";

async function readSnp(handles: string[][], address: string, researcher: any) {
  const result: number[][] = [];
  for (let g = 0; g < 2; g++) {
    const row: number[] = [];
    for (let d = 0; d < 3; d++) {
      row.push(Number(await fhevm.userDecryptEuint(
        FhevmType.euint32, handles[g][d], address, researcher,
      )));
    }
    result.push(row);
  }
  return result;
}

describe("E/18 encrypted disclosure gates", () => {
  async function fixture() {
    const [, researcher] = await ethers.getSigners();
    const contingency = await (await ethers.getContractFactory("ContingencyStats")).deploy();
    const biomarker = await (await ethers.getContractFactory("BiomarkerStats")).deploy();
    await Promise.all([contingency.waitForDeployment(), biomarker.waitForDeployment()]);
    const Factory = await ethers.getContractFactory("E18DisclosureHarness", {
      libraries: {
        ContingencyStats: await contingency.getAddress(),
        BiomarkerStats: await biomarker.getAddress(),
      },
    });
    const harness = await Factory.deploy();
    await harness.waitForDeployment();
    return { harness, researcher, address: await harness.getAddress() };
  }

  it("grants the complete 2x3 table only at 30 covered people per group and >=5 per cell", async () => {
    const { harness, researcher, address } = await fixture();
    const counts = [[5, 10, 15], [12, 8, 10]];
    await harness.seedSnp(counts);
    await harness.grantSnpSafe(await researcher.getAddress());
    expect(await readSnp(await harness.safeSnp(), address, researcher)).to.deep.equal(counts);
    const raw = await harness.rawSnp();
    await expect(fhevm.userDecryptEuint(
      FhevmType.euint32, raw[0][0], address, researcher,
    )).to.be.rejected;
  });

  it("masks every cell when any cell is 1-4, even with 30+30 group totals", async () => {
    const { harness, researcher, address } = await fixture();
    await harness.seedSnp([[4, 13, 13], [10, 10, 10]]);
    await harness.grantSnpSafe(await researcher.getAddress());
    expect(await readSnp(await harness.safeSnp(), address, researcher)).to.deep.equal([
      [0, 0, 0], [0, 0, 0],
    ]);
  });

  it("masks every cell when a group has under 30 covered people", async () => {
    const { harness, researcher, address } = await fixture();
    await harness.seedSnp([[9, 10, 10], [10, 10, 10]]);
    await harness.grantSnpSafe(await researcher.getAddress());
    expect(await readSnp(await harness.safeSnp(), address, researcher)).to.deep.equal([
      [0, 0, 0], [0, 0, 0],
    ]);
  });

  it("masks BMI sufficient statistics if either covered group has under 30", async () => {
    const { harness, researcher, address } = await fixture();
    await harness.seedMetric([29, 31], [725, 930], [18125, 27900]);
    await harness.grantMetricSafe(await researcher.getAddress());
    for (let group = 0; group < 2; group++) {
      const [sum, sumSq, count] = await harness.safeMetric(group);
      expect(await fhevm.userDecryptEuint(FhevmType.euint64, sum, address, researcher)).to.equal(0n);
      expect(await fhevm.userDecryptEuint(FhevmType.euint64, sumSq, address, researcher)).to.equal(0n);
      expect(await fhevm.userDecryptEuint(FhevmType.euint32, count, address, researcher)).to.equal(0n);
      const [rawSum] = await harness.rawMetric(group);
      await expect(fhevm.userDecryptEuint(FhevmType.euint64, rawSum, address, researcher)).to.be.rejected;
    }
  });

  it("grants both BMI groups at exactly 30 covered observations", async () => {
    const { harness, researcher, address } = await fixture();
    await harness.seedMetric([30, 30], [750, 900], [18750, 27000]);
    await harness.grantMetricSafe(await researcher.getAddress());
    const expected = [[750n, 18750n, 30n], [900n, 27000n, 30n]];
    for (let group = 0; group < 2; group++) {
      const [sum, sumSq, count] = await harness.safeMetric(group);
      expect(await fhevm.userDecryptEuint(FhevmType.euint64, sum, address, researcher)).to.equal(expected[group][0]);
      expect(await fhevm.userDecryptEuint(FhevmType.euint64, sumSq, address, researcher)).to.equal(expected[group][1]);
      expect(await fhevm.userDecryptEuint(FhevmType.euint32, count, address, researcher)).to.equal(expected[group][2]);
    }
  });
});

describe("E/18 one-snapshot protocol boundary", () => {
  it("opens one eligible 30+30 cohort, grants only masked handles, and rejects N+1", async function () {
    this.timeout(180_000);
    const [owner, researcher, node] = await ethers.getSigners();
    const verifier = await (await ethers.getContractFactory("DataProvenanceVerifier")).deploy();
    await verifier.waitForDeployment();
    const Protocol = await protocolFactory("VeriarfyProtocolE18");
    const protocol: any = await Protocol.deploy(
      await owner.getAddress(), 2, await verifier.getAddress(), 0,
    );
    await protocol.waitForDeployment();
    const address = await protocol.getAddress();
    const Biomarkers = await biomarkersFactory();
    const biomarkers: any = await Biomarkers.deploy(address);
    await biomarkers.waitForDeployment();
    const metricAddress = await biomarkers.getAddress();
    await protocol.setBiomarkerModule(metricAddress);
    await biomarkers.configureMetrics([{
      code: ethers.encodeBytes32String("BMI"),
      unit: ethers.encodeBytes32String("kg/m2"),
      scale: 100,
      offset: 0,
      minValue: 1000,
      maxValue: 8000,
    }], ethers.id("e18-synthetic-bmi"), "ipfs://e18-synthetic-bmi");
    await protocol.authorizeNode(await node.getAddress());
    await protocol.setQueryGateway(await node.getAddress());
    await expect(protocol.connect(node).requestDisclosureFields(
      await researcher.getAddress(), 4, [0], [0],
    )).to.be.revertedWithCustomError(protocol, "NotQueryGateway");
    await protocol.setQueryGateway(await owner.getAddress());
    expect(await protocol.e18DisclosurePolicyActive()).to.equal(true);
    expect(await protocol.minParticipants()).to.equal(60n);
    await expect(protocol.setMinParticipants(59)).to.be.revertedWithCustomError(
      protocol, "E18ThresholdTooLow",
    );

    const cohort = makeE18SyntheticCohort();
    const plaintext = e18PlaintextReference(cohort);

    async function contribute(index: number) {
      const row = cohort[index];
      const walletAddress = `0x${(10_000 + index).toString(16).padStart(40, "0")}`;
      await ethers.provider.send("hardhat_setBalance", [walletAddress, "0xDE0B6B3A7640000"]);
      await ethers.provider.send("hardhat_impersonateAccount", [walletAddress]);
      const participant = await ethers.getSigner(walletAddress);
      const encryptedGroup = await fhevm.createEncryptedInput(address, walletAddress).add8(row.group).encrypt();
      await protocol.connect(participant).enroll(encryptedGroup.handles[0], encryptedGroup.inputProof);
      const encryptedDosage = await fhevm.createEncryptedInput(address, walletAddress).add8(row.dosage).encrypt();
      await protocol.connect(participant).contributeDosages(
        encryptedDosage.handles, 1, encryptedDosage.inputProof,
      );
      const encryptedBmi = await fhevm.createEncryptedInput(metricAddress, walletAddress).add32(row.bmi).encrypt();
      await biomarkers.connect(participant).contributeBiomarkers(
        encryptedBmi.handles, 1, encryptedBmi.inputProof,
      );
    }

    for (let index = 0; index < cohort.length; index++) await contribute(index);
    expect(await protocol.participantCount()).to.equal(BigInt(plaintext.participantCount));
    await protocol.requestDisclosureFields(await researcher.getAddress(), 4, [0], [0]);
    await protocol.connect(node).approveDisclosure(0);
    await protocol.setMinParticipants(61);
    await expect(protocol.executeDisclosure(0)).to.be.revertedWithCustomError(
      protocol, "NotEnoughParticipants",
    );
    await protocol.setMinParticipants(60);
    await protocol.executeDisclosure(0);

    expect(await readSnp(await protocol.disclosureContingencyAt(0, 0), address, researcher)).to.deep.equal([
      plaintext.contingency[0], plaintext.contingency[1],
    ]);
    const raw = await protocol.contingencyTableAt(0);
    await expect(fhevm.userDecryptEuint(
      FhevmType.euint32, raw[0][0], address, researcher,
    )).to.be.rejected;
    await expect(fhevm.userDecryptEuint(
      FhevmType.euint32, await protocol.disclosureSnapshot(0), address, researcher,
    )).to.be.rejected;
    for (let group = 0; group < 2; group++) {
      const [sum, sumSq, count] = await biomarkers.disclosureBiomarkerAt(0, 0, group);
      const expected = plaintext.bmi[group];
      expect(await fhevm.userDecryptEuint(FhevmType.euint64, sum, metricAddress, researcher)).to.equal(BigInt(expected.sum));
      expect(await fhevm.userDecryptEuint(FhevmType.euint64, sumSq, metricAddress, researcher)).to.equal(BigInt(expected.sumSq));
      expect(await fhevm.userDecryptEuint(FhevmType.euint32, count, metricAddress, researcher)).to.equal(BigInt(expected.n));
      const [rawSum] = await biomarkers.biomarkerAggregate(0, group);
      await expect(fhevm.userDecryptEuint(FhevmType.euint64, rawSum, metricAddress, researcher)).to.be.rejected;
    }

    await expect(protocol.requestDisclosureFields(await researcher.getAddress(), 4, [0], [0]))
      .to.be.revertedWithCustomError(protocol, "E18AlreadyRequested");
    await expect(protocol.requestDisclosureFields(await node.getAddress(), 4, [0], [0]))
      .to.be.revertedWithCustomError(protocol, "E18AlreadyRequested");
  });
});
