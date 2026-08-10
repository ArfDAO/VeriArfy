import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/mock-utils";
import type { Signer } from "ethers";

/**
 * FHEVM mock ortaminda kasa akisini dogrular:
 *   kayit ol (registry) -> sifreli deger yukle -> kohort toplami cozulunce dogru.
 *
 * Not: Bu test `@fhevm/hardhat-plugin`'in sagladigi `fhevm` yardimcilarini
 * kullanir; `hardhat` aginda mock koprusu ile calisir.
 */
describe("VeriArfyVault", () => {
  let deployer: Signer;
  let researcher: Signer;
  let researcherAddr: string;
  let vault: any;
  let registry: any;

  // Registry'de gercek ZK kaniti yerine, test icin dogrudan kayit yapabilmek
  // adina bir "AllowAllVerifier" kullaniriz.
  before(async () => {
    [deployer, researcher] = await ethers.getSigners();
    researcherAddr = await researcher.getAddress();

    const Allow = await ethers.getContractFactory("AllowAllVerifier");
    const verifier = await Allow.deploy();
    await verifier.waitForDeployment();

    const Registry = await ethers.getContractFactory("VeriArfyRegistry");
    // initialRoot = 1 (gecerli, sifir olmayan bir kok)
    registry = await Registry.deploy(await verifier.getAddress(), 1);
    await registry.waitForDeployment();

    const Vault = await ethers.getContractFactory("VeriArfyVault");
    vault = await Vault.deploy(await registry.getAddress());
    await vault.waitForDeployment();

    // Arastirmaciyi kaydet (AllowAllVerifier her kaniti kabul eder).
    const dummyA: [bigint, bigint] = [1n, 2n];
    const dummyB: [[bigint, bigint], [bigint, bigint]] = [
      [1n, 2n],
      [3n, 4n],
    ];
    const dummyC: [bigint, bigint] = [1n, 2n];
    await registry
      .connect(researcher)
      .register(1, 12345, dummyA, dummyB, dummyC);
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
