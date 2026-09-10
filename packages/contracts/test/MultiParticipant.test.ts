import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import type { Signer } from "ethers";
import { join } from "node:path";
import { protocolFactory } from "./helpers/factories";
import { fullProveIsolated } from "../scripts/isolated-proof";

/**
 * D/17 deterministik ekonomik fixture.
 *
 * Bu test, bir sorgunun acilis anindaki 3 ve 5 katilimcili goruntusunu
 * gercek FHE mock akisi ile kurar. Alice ortak + nadir alanlari, digerleri
 * ortak alani ve nadir alan icin 3 (missing sentinel) gonderir.
 */
describe("D/17 multi participant economic flow", () => {
  let owner: Signer;
  let researcher: Signer;
  let nodeA: Signer;
  let nodeB: Signer;
  let nodeC: Signer;
  let participants: Signer[];
  let late: Signer;
  let protocol: any;
  let payments: any;
  let token: any;
  let protocolAddress: string;

  const BASE_FEE = 10_000_000n;
  const PER_PARTICIPANT_FEE = 1_000_000n;
  const LIQUIDITY_SHARE_BPS = 8_000;
  const QUERY_TYPE_STATISTICS = 4;

  beforeEach(async () => {
    const signers = await ethers.getSigners();
    [owner, researcher, nodeA, nodeB, nodeC] = signers;
    participants = signers.slice(5, 10);
    late = signers[10];

    const Token = await ethers.getContractFactory("StableTestToken");
    token = await Token.deploy(await owner.getAddress());
    await token.waitForDeployment();

    const Verifier = await ethers.getContractFactory("DataProvenanceVerifier");
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();

    const Protocol = await protocolFactory();
    protocol = await Protocol.deploy(
      await owner.getAddress(),
      2,
      3,
      await verifier.getAddress(),
      0n,
    );
    await protocol.waitForDeployment();
    protocolAddress = await protocol.getAddress();

    for (const node of [nodeA, nodeB, nodeC]) {
      await protocol.connect(owner).authorizeNode(await node.getAddress());
    }
    await protocol.connect(owner).configurePanel(2, 1, ethers.ZeroHash, "d17-local");

    // The researcher registry is a real identity registry, as in the payment
    // integration tests; no payment or protocol authorization is mocked.
    const circuits = await import("@veriarfy/circuits");
    const identityTree = new circuits.IdentityTree();
    const identity = circuits.createIdentity();
    identityTree.insert(identity.commitment);
    const IdentityVerifier = await ethers.getContractFactory("Groth16Verifier");
    const identityVerifier = await IdentityVerifier.deploy();
    await identityVerifier.waitForDeployment();
    const Registry = await ethers.getContractFactory("VeriArfyRegistry");
    const registry = await Registry.deploy(await identityVerifier.getAddress(), identityTree.root);
    await registry.waitForDeployment();
    const identityInput = circuits.buildCircuitInput({
      identity,
      tree: identityTree,
      externalNullifier: 1n,
      signerAddress: await researcher.getAddress(),
    });
    const identityWasm = join(
      __dirname, "..", "..", "circuits", "build", "researcher_identity_js", "researcher_identity.wasm",
    );
    const identityZkey = join(
      __dirname, "..", "..", "circuits", "build", "researcher_identity_final.zkey",
    );
    const identityResult = await fullProveIsolated(identityInput, identityWasm, identityZkey);
    const identityCalldata = circuits.toSolidityCalldata(identityResult.proof as any);
    await registry.connect(researcher).register(
      identityTree.root,
      circuits.computeNullifierHash(1n, identity.nullifier),
      identityCalldata.a,
      identityCalldata.b,
      identityCalldata.c,
    );

    const Payments = await ethers.getContractFactory("VeriarfyPayments");
    payments = await Payments.deploy(
      await owner.getAddress(),
      await token.getAddress(),
      protocolAddress,
      await registry.getAddress(),
      LIQUIDITY_SHARE_BPS,
      BASE_FEE,
      PER_PARTICIPANT_FEE,
    );
    await payments.waitForDeployment();
    await protocol.connect(owner).setQueryGateway(await payments.getAddress());
    await token.connect(owner).mint(await researcher.getAddress(), 1_000_000_000n);
    await token.connect(researcher).approve(await payments.getAddress(), ethers.MaxUint256);
  });

  async function contribute(signer: Signer, rare: boolean, includeRare = rare) {
    const address = await signer.getAddress();
    const group = await fhevm.createEncryptedInput(protocolAddress, address).add8(0).encrypt();
    await protocol.connect(signer).enroll(group.handles[0], group.inputProof);
    const dosages = await fhevm
      .createEncryptedInput(protocolAddress, address)
      .add8(1)
      .add8(includeRare ? (rare ? 2 : 1) : 3)
      .encrypt();
    await protocol.connect(signer).contributeDosages(
      [dosages.handles[0], dosages.handles[1]],
      includeRare ? 3n : 1n,
      dosages.inputProof,
    );
  }

  async function assessRarity(signer: Signer) {
    await protocol.connect(signer).requestRarityAssessment();
    const handle = await protocol.rarityHandle(await signer.getAddress());
    const result = await fhevm.publicDecrypt([handle]);
    await protocol.connect(signer).confirmRarity(
      await signer.getAddress(),
      result.abiEncodedClearValues,
      result.decryptionProof,
    );
  }

  async function openAndSettle(count: number): Promise<bigint> {
    const tx = await payments.connect(researcher).openQueryFields(
      QUERY_TYPE_STATISTICS,
      [0, 1],
      [],
    );
    await tx.wait();
    const queryId = (await payments.nextQueryId()) - 1n;
    const q = await payments.query(queryId);
    await protocol.connect(nodeA).approveDisclosure(q.disclosureRequestId);
    await protocol.connect(nodeB).approveDisclosure(q.disclosureRequestId);
    await protocol.executeDisclosure(q.disclosureRequestId);
    await payments.settleQuery(queryId);
    expect((await payments.query(queryId)).snapshotCount).to.equal(count);
    return queryId;
  }

  async function runScenario(count: 3 | 5) {
    const current = participants.slice(0, count);
    for (let i = 0; i < current.length; i++) await contribute(current[i], i === 0);
    for (const signer of current) await assessRarity(signer);

    expect(await protocol.participantCount()).to.equal(count);
    expect(await protocol.snpCoverageCount(0)).to.equal(count);
    expect(await protocol.snpCoverageCount(1)).to.equal(1);
    expect(await protocol.snpCoverageTotal([0, 1])).to.equal(BigInt(count + 1));
    expect(await protocol.isRareCarrier(await current[0].getAddress())).to.equal(true);
    for (const signer of current.slice(1)) {
      expect(await protocol.isRareCarrier(await signer.getAddress())).to.equal(false);
    }

    const queryId = await openAndSettle(count);
    const q = await payments.query(queryId);
    const [usagePot, bonusPot] = await payments.potSplit(queryId);
    expect(usagePot).to.be.greaterThan(0n);
    expect(bonusPot).to.be.greaterThan(0n);
    expect(q.coverageTotal).to.equal(BigInt(count + 1));

    const coverage = await Promise.all(current.map(async (s) =>
      payments.coverageWeight(queryId, await s.getAddress()),
    ));
    const weighted = await Promise.all(current.map(async (s) =>
      payments.weightedCoverage(queryId, await s.getAddress()),
    ));
    expect(coverage[0]).to.equal(2n);
    for (const value of coverage.slice(1)) expect(value).to.equal(1n);
    expect(weighted[0]).to.be.greaterThan(weighted[1]);
    const weightedTotal = await payments.weightedTotal(queryId);
    expect(weighted.reduce((sum, value) => sum + value, 0n)).to.equal(weightedTotal);

    const [poolCount, carriers, multiplier, totalWeight] = await payments.queryWeights(queryId);
    expect(poolCount).to.equal(count);
    expect(carriers).to.equal(1);
    expect(multiplier).to.be.greaterThan(10_000n);
    const weights = await Promise.all(current.map(async (s) =>
      payments.weightOf(queryId, await s.getAddress()),
    ));
    expect(weights[0]).to.be.greaterThan(weights[1]);
    expect(weights.reduce((sum, value) => sum + value, 0n)).to.equal(totalWeight);

    const expected = await Promise.all(current.map(async (s) =>
      payments.claimable(queryId, await s.getAddress()),
    ));
    const modeledWeights = current.map((_s, i) =>
      (i === 0 ? multiplier : 10_000n) * 3n / 2n,
    );
    const modeledPayouts = current.map((_s, i) =>
      usagePot * weighted[i] / weightedTotal + bonusPot * modeledWeights[i] / totalWeight,
    );
    expect(weights).to.deep.equal(modeledWeights);
    expect(expected).to.deep.equal(modeledPayouts);
    expect(expected[0]).to.be.greaterThan(expected[1]);
    const before = await Promise.all(current.map(async (s) => token.balanceOf(await s.getAddress())));
    for (let i = 0; i < current.length; i++) {
      await payments.connect(current[i]).claim(queryId);
      const after = await token.balanceOf(await current[i].getAddress());
      expect(after - before[i]).to.equal(expected[i]);
      await expect(payments.connect(current[i]).claim(queryId))
        .to.be.revertedWithCustomError(payments, "AlreadyClaimed");
    }
    const totalPaid = expected.reduce((sum, value) => sum + value, 0n);
    const settled = await payments.query(queryId);
    expect(settled.claimedTotal).to.equal(totalPaid);
    expect(totalPaid).to.be.lessThanOrEqual(settled.liquidityPot);
    expect(settled.liquidityPot - totalPaid).to.be.lessThan(2n * BigInt(count));

    return { queryId, current };
  }

  it("3 katilimci: nadir alan, odeme ve gec katilimci siniri", async () => {
    const { queryId, current } = await runScenario(3);
    await contribute(late, false);
    expect(await protocol.participantCount()).to.equal(4);
    expect(await payments.claimable(queryId, await late.getAddress())).to.equal(0n);
    await expect(payments.connect(late).claim(queryId))
      .to.be.revertedWithCustomError(payments, "NotInThisQuery");
    expect(await protocol.participantIndex(await current[0].getAddress())).to.equal(1);
  });

  it("5 katilimci: ayni formulu genis panelde korur", async () => {
    await runScenario(5);
  });

  it("3 yeni + 1 mevcut: D15 baseline ile delta kitlik ve tam dagitim", async () => {
    // Existing D15 deployer: both fields are covered, but its rare status is
    // intentionally ordinary. The new rare carrier must earn the scarcity
    // weight independently of this baseline participant's bonus status.
    await contribute(late, false, true);
    await assessRarity(late);

    const current = participants.slice(0, 3);
    for (let i = 0; i < current.length; i++) await contribute(current[i], i === 0);
    for (const signer of current) await assessRarity(signer);

    expect(await protocol.participantCount()).to.equal(4);
    expect(await protocol.snpCoverageCount(0)).to.equal(4);
    expect(await protocol.snpCoverageCount(1)).to.equal(2);
    const queryId = await openAndSettle(4);
    const q = await payments.query(queryId);
    expect(q.coverageTotal).to.equal(6n);
    const [poolCount, carriers, multiplier, totalWeight] = await payments.queryWeights(queryId);
    expect(poolCount).to.equal(4);
    expect(carriers).to.equal(1);
    expect(multiplier >= 20_000n).to.equal(true);

    const cohort = [late, ...current];
    const weighted = await Promise.all(cohort.map(async (s) =>
      payments.weightedCoverage(queryId, await s.getAddress()),
    ));
    expect(weighted).to.deep.equal([30_000n, 30_000n, 10_000n, 10_000n]);
    expect(await payments.weightedTotal(queryId)).to.equal(80_000n);

    const [usagePot, bonusPot] = await payments.potSplit(queryId);
    const modeledWeights = [15_000n, multiplier * 3n / 2n, 15_000n, 15_000n];
    const expected = await Promise.all(cohort.map(async (s) =>
      payments.claimable(queryId, await s.getAddress()),
    ));
    const modeled = weighted.map((value, i) =>
      usagePot * value / 80_000n + bonusPot * modeledWeights[i] / totalWeight,
    );
    expect(expected).to.deep.equal(modeled);
    expect(expected[1]).to.be.greaterThan(expected[2]);

    let paid = 0n;
    for (let i = 0; i < cohort.length; i++) {
      await payments.connect(cohort[i]).claim(queryId);
      paid += expected[i];
    }
    const settled = await payments.query(queryId);
    expect(settled.claimedTotal).to.equal(paid);
    expect(paid).to.be.lessThanOrEqual(settled.liquidityPot);
    expect(settled.liquidityPot - paid).to.be.lessThan(8n);
  });
});
