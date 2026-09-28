import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/mock-utils";

describe("VeriarfyBmiDemo", () => {
  async function encryptWeight(contractAddress: string, account: string, deciKg: number) {
    return fhevm.createEncryptedInput(contractAddress, account).add16(deciKg).encrypt();
  }

  it("calculates the same fixed-point BMI from encrypted weight", async () => {
    const [demonstrator] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("VeriarfyBmiDemo");
    const demo = await Factory.deploy();
    await demo.waitForDeployment();
    const address = await demo.getAddress();

    // 72.4 kg and 175 cm: floor(724 * 100000 / 175²) = 23.64 BMI.
    const encrypted = await encryptWeight(address, demonstrator.address, 724);
    await demo.calculate(encrypted.handles[0], 175, encrypted.inputProof);

    const handle = await demo.bmiHandle(demonstrator.address);
    expect(await fhevm.publicDecryptEuint(FhevmType.euint32, handle)).to.equal(2364n);
  });

  it("uses a public height denominator but never exposes the encrypted weight handle", async () => {
    const [demonstrator] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("VeriarfyBmiDemo");
    const demo = await Factory.deploy();
    await demo.waitForDeployment();
    const encrypted = await encryptWeight(await demo.getAddress(), demonstrator.address, 720);

    await demo.calculate(encrypted.handles[0], 175, encrypted.inputProof);
    await expect(fhevm.publicDecryptEuint(FhevmType.euint16, encrypted.handles[0])).to.be.rejected;
    // The deployed contract publishes only `bmiHandle`, never the input handle.
    expect(await demo.bmiHandle(demonstrator.address)).to.not.equal(encrypted.handles[0]);
  });

  it("rejects an invalid public height before FHE computation", async () => {
    const [demonstrator] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("VeriarfyBmiDemo");
    const demo = await Factory.deploy();
    await demo.waitForDeployment();
    const encrypted = await encryptWeight(await demo.getAddress(), demonstrator.address, 720);

    await expect(demo.calculate(encrypted.handles[0], 99, encrypted.inputProof))
      .to.be.revertedWithCustomError(demo, "InvalidHeight")
      .withArgs(99);
  });
});
