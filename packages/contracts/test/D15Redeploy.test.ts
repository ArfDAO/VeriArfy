import { strict as assert } from "node:assert";
import { join } from "node:path";
import { ethers, network } from "hardhat";
import { buildRedeployPlan, hashPlan, transactionFor, assertTransaction, type RedeployPlan } from "../scripts/d15-redeploy-plan";
import { fullProveIsolated } from "../scripts/isolated-proof";
import { verifyFinalState, verifySyntheticProofs, assertPublishedRecord, outputRecord, type RedeployReceipt } from "../scripts/d15-redeploy";

// Ordinary CI may create its own development ceremony. Frozen D15 keys are
// tested explicitly after pin validation, not silently replaced by CI output.
const describePinned = process.env.D15_PINNED_ARTIFACT_TESTS === "1" ? describe : describe.skip;
describePinned("D15 nonce-24 redeployment", function () {
  this.timeout(90_000);
  let plan: RedeployPlan;
  let snapshot: string;
  const receipts: RedeployReceipt[] = [];

  before(async () => {
    assert.equal(network.name, "hardhat", "simulation requires disposable Hardhat network");
    snapshot = await network.provider.send("evm_snapshot");
    plan = await buildRedeployPlan();
  });
  after(async () => { if (snapshot) await network.provider.send("evm_revert", [snapshot]); });

  it("binds nonces, payloads, fees and budget into the reviewed plan", () => {
    assert.equal(plan.steps.length, 18);
    assert.deepEqual(plan.steps.map(s => s.nonce), Array.from({ length: 18 }, (_, i) => 24 + i));
    assert.equal(plan.steps.filter(s => s.address).length, 8);
    const changed = structuredClone(plan);
    changed.steps[0].gasLimit = "1";
    assert.notEqual(hashPlan(changed), hashPlan(plan));
    const step = plan.steps[0];
    const tx = { ...transactionFor(plan, step), from: plan.deployer };
    assert.doesNotThrow(() => assertTransaction(plan, step, tx));
    for (const overrides of [{ nonce: 25 }, { value: 1n }, { data: "0x00" }, { maxFeePerGas: 1n }, { chainId: 1 }]) {
      assert.throws(() => assertTransaction(plan, step, { ...tx, ...overrides }));
    }
  });

  it("executes all 18 exact payloads and validates the eight linked runtimes", async () => {
    await network.provider.send("hardhat_setBalance", [plan.deployer, ethers.toBeHex(ethers.parseEther("10"))]);
    await network.provider.send("hardhat_impersonateAccount", [plan.deployer]);
    const signer = await ethers.getSigner(plan.deployer);
    // Recreate the five reused contracts at their original CREATE addresses.
    for (const [nonce, name, args] of [
      [4, "ContingencyStats", []], [5, "CoverageBits", []],
      [9, "StableTestToken", [plan.deployer]], [11, "BiomarkerStats", []],
      [22, "VeriarfyStorage", [plan.deployer, 1598306400]],
    ] as [number, string, any[]][]) {
      await network.provider.send("hardhat_setNonce", [plan.deployer, ethers.toQuantity(nonce)]);
      const factory = await ethers.getContractFactory(name, signer);
      const contract = await factory.deploy(...args);
      await contract.waitForDeployment();
      assert.equal(await contract.getAddress(), plan.reused[name].address);
      assert.equal(ethers.keccak256(await ethers.provider.getCode(await contract.getAddress())), plan.reused[name].runtimeHash);
    }
    const storage: any = await ethers.getContractAt("VeriarfyStorage", plan.contracts.VeriarfyStorage, signer);
    await (await storage.setAttestor(plan.deployer)).wait();
    assert.equal(await ethers.provider.getTransactionCount(plan.deployer), 24);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    let totalGas = 0n;
    for (const step of plan.steps) {
      const tx = await signer.sendTransaction({ ...transactionFor(plan, step), chainId });
      const receipt = await tx.wait();
      assert.equal(receipt?.status, 1, step.label);
      receipts.push({ nonce: step.nonce, hash: tx.hash, blockNumber: receipt!.blockNumber });
      assert.equal(tx.nonce, step.nonce);
      assert.ok(receipt!.gasUsed < BigInt(step.gasLimit), `${step.label} gas ceiling`);
      totalGas += receipt!.gasUsed;
      if (step.address) {
        assert.equal(receipt!.contractAddress, step.address);
        assert.equal(ethers.keccak256(await ethers.provider.getCode(step.address)), step.runtimeHash, step.label);
      }
    }
    const protocol: any = await ethers.getContractAt("VeriarfyProtocol", plan.contracts.VeriarfyProtocol);
    assert.equal(await protocol.queryGateway(), plan.contracts.VeriarfyPayments);
    assert.equal(await protocol.biomarkerModule(), plan.contracts.VeriarfyBiomarkers);
    assert.equal(await protocol.stakingModule(), plan.contracts.VeriarfyStaking);
    assert.equal(await protocol.requiredApprovals(2), 2n);
    assert.equal(await protocol.participantCount(), 0n);
    assert.equal(await ethers.provider.getTransactionCount(plan.deployer), 42);
    console.log(`    local simulation gas=${totalGas}; capped gas=${BigInt(plan.maxCostWei) / BigInt(plan.maxFeePerGas)}`);
    await verifyFinalState(plan, ethers.provider);
    const record = outputRecord(plan, receipts);
    assert.doesNotThrow(() => assertPublishedRecord(plan, receipts, record));
    assert.throws(() => assertPublishedRecord(plan, receipts, { ...record, deployedAtBlock: 1 }));
    assert.throws(() => assertPublishedRecord(plan, receipts, { ...record, contracts: {} }));
  });

  it("accepts both frozen-key proofs in the newly deployed verifiers", async () => {
    await verifySyntheticProofs(plan, ethers.provider);
    const circuits: any = require("@veriarfy/circuits");
    const provenance: any = require("@veriarfy/circuits/provenance");
    const build = join(__dirname, "..", "..", "circuits", "build");
    const identity = circuits.createIdentity();
    const tree = new circuits.IdentityTree();
    tree.insert(identity.commitment);
    const inputs: [string, string, any][] = [
      ["researcher_identity", "Groth16Verifier", circuits.buildCircuitInput({ identity, tree, externalNullifier: 20260814n, signerAddress: plan.deployer })],
      ["data_provenance", "DataProvenanceVerifier", provenance.buildSelfProvenanceInput({
        dosages: Array.from({ length: provenance.PANEL_SIZE }, (_, i) => i % 3), salt: 123n,
        externalNullifier: 20260814n, cidDigest: ethers.keccak256(ethers.toUtf8Bytes("d15-redeploy-test")), signerAddress: plan.deployer,
      })],
    ];
    for (const [circuit, name, input] of inputs) {
      const result = await fullProveIsolated(input, join(build, `${circuit}_js`, `${circuit}.wasm`), join(build, `${circuit}_final.zkey`));
      const { a, b, c } = circuits.toSolidityCalldata(result.proof);
      const verifier: any = await ethers.getContractAt(name, plan.contracts[name]);
      assert.equal(await verifier.verifyProof(a, b, c, result.publicSignals), true, name);
      const altered = [...result.publicSignals];
      altered[0] = String(BigInt(altered[0]) + 1n);
      assert.equal(await verifier.verifyProof(a, b, c, altered), false, `${name} altered signal`);
    }
  });
});
