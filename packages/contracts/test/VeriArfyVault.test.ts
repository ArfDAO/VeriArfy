import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/mock-utils";
import type { Signer } from "ethers";

/**
 * Kasa akisini uctan uca dogrular:
 *   ZK ile kayit ol -> sifreli deger yukle -> kohort toplami cozulunce dogru.
 *
 * # Sahte dogrulayici KALDIRILDI
 *
 * Bu test onceden `AllowAllVerifier` kullaniyordu — her kaniti kosulsuz kabul
 * eden bir kontrat — ve uydurma kanit bilesenleriyle kayit yapiyordu. Bu,
 * kasanin "yalnizca kayitli arastirmaci yukleyebilir" garantisini test etmiyor,
 * yalnizca varsayiyordu: registry gercekte hicbir sey dogrulamadigi icin kapi
 * bosunaydi.
 *
 * Artik `Groth16Verifier` (snarkjs ciktisi) ve snarkjs'in urettigi GERCEK bir
 * kanit kullanilir. Sahte kontrat depodan tamamen silindi.
 */
describe("VeriArfyVault", () => {
  let deployer: Signer;
  let researcher: Signer;
  let researcherAddr: string;
  let vault: any;
  let registry: any;

  const CIRCUITS = join(__dirname, "..", "..", "circuits");
  const WASM = join(CIRCUITS, "build", "researcher_identity_js", "researcher_identity.wasm");
  const ZKEY = join(CIRCUITS, "build", "researcher_identity_final.zkey");

  /** `VeriArfyRegistry.EXTERNAL_NULLIFIER` ile ayni olmali. */
  const EXTERNAL_NULLIFIER = 1n;

  before(async () => {
    if (!existsSync(ZKEY)) {
      throw new Error("Devre ciktilari yok. Once `npm run circuits:build` calistirin.");
    }

    [deployer, researcher] = await ethers.getSigners();
    researcherAddr = await researcher.getAddress();

    const circuits = await import("@veriarfy/circuits");
    const snarkjs: any = await import("snarkjs");

    // Gercek Poseidon Merkle agaci ve gercek kimlik.
    const tree = new circuits.IdentityTree();
    const identity = circuits.createIdentity();
    tree.insert(identity.commitment);

    const Verifier = await ethers.getContractFactory("Groth16Verifier");
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();

    const Registry = await ethers.getContractFactory("VeriArfyRegistry");
    registry = await Registry.deploy(await verifier.getAddress(), tree.root);
    await registry.waitForDeployment();

    const Vault = await ethers.getContractFactory("VeriArfyVault");
    vault = await Vault.deploy(await registry.getAddress());
    await vault.waitForDeployment();

    // GERCEK ZK kaniti: kimlik acilmadan agacta oldugu ispatlanir.
    const input = circuits.buildCircuitInput({
      identity,
      tree,
      externalNullifier: EXTERNAL_NULLIFIER,
      signerAddress: researcherAddr,
    });
    const { proof } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    const calldata = circuits.toSolidityCalldata(proof);

    await registry
      .connect(researcher)
      .register(
        tree.root,
        circuits.computeNullifierHash(EXTERNAL_NULLIFIER, identity.nullifier),
        calldata.a,
        calldata.b,
        calldata.c,
      );

    expect(await registry.isRegistered(researcherAddr)).to.equal(true);
  });

  it("sifreli kayit yukler ve kohort toplami dogru cozulur", async () => {
    const vaultAddr = await vault.getAddress();

    async function submit(value: number) {
      const enc = await fhevm
        .createEncryptedInput(vaultAddr, researcherAddr)
        .add32(value)
        .encrypt();
      await vault
        .connect(researcher)
        .submitRecord(0 /* Genomics */, ethers.ZeroHash, enc.handles[0], enc.inputProof);
    }

    await submit(42);
    await submit(58);

    expect(await vault.cohortCount(0)).to.equal(2);

    const sumHandle = await vault.cohortSum(0);
    const clearSum = await fhevm.userDecryptEuint(
      FhevmType.euint32,
      sumHandle,
      vaultAddr,
      deployer, // kasa owner'i toplami cozebilir
    );
    expect(clearSum).to.equal(100n);
  });
});
