import { ethers, network } from "hardhat";

import { D15_PROFILE_ID, loadD15Profile } from "./d15-profile";

/** Deploy oncesi salt-okunur ucus kontrolu. */
const MINIMUM_BALANCE = ethers.parseEther("0.02");

async function main() {
  const d15Profile =
    process.env.D15_PROFILE === D15_PROFILE_ID ? loadD15Profile() : null;
  if (process.env.D15_PROFILE && !d15Profile) {
    throw new Error(`bilinmeyen D15_PROFILE: ${process.env.D15_PROFILE}`);
  }

  const chain = await ethers.provider.getNetwork();
  const blockNumber = await ethers.provider.getBlockNumber();
  console.log(`Ag       : ${network.name} (chainId ${chain.chainId})`);
  console.log(`Blok     : ${blockNumber}`);

  let deployerAddress: string;
  if (d15Profile) {
    if (
      network.name !== d15Profile.network ||
      chain.chainId !== BigInt(d15Profile.chainId)
    ) {
      throw new Error("D15 preflight profile agiyla eslesmiyor");
    }
    if ((await ethers.getSigners()).length !== 0) {
      throw new Error("D15 preflight private key yuklememelidir");
    }
    deployerAddress = d15Profile.deployer;
  } else {
    const signers = await ethers.getSigners();
    if (signers.length === 0) {
      throw new Error(
        "Imzalayan yok. DEPLOYER_PRIVATE_KEY okunamadi; .env ve " +
          "hardhat.config.ts kontrol edilmeli",
      );
    }
    if (signers.length !== 1) {
      throw new Error(`Preflight tam bir signer bekler; bulunan: ${signers.length}`);
    }
    deployerAddress = signers[0].address;
  }

  const balance = await ethers.provider.getBalance(deployerAddress);
  console.log(`Deployer : ${deployerAddress}`);
  console.log(`Bakiye   : ${ethers.formatEther(balance)} ETH`);

  const feeData = await ethers.provider.getFeeData();
  if (feeData.gasPrice) {
    console.log(`Gas      : ${ethers.formatUnits(feeData.gasPrice, "gwei")} gwei`);
  }

  const minimumBalance = d15Profile?.minimumDeployerBalanceWei ?? MINIMUM_BALANCE;
  if (balance < minimumBalance) {
    throw new Error(
      `Bakiye yetersiz: ${ethers.formatEther(balance)} ETH var, ` +
        `en az ${ethers.formatEther(minimumBalance)} ETH gerekiyor. ` +
        "Sepolia faucet'inden test ETH alin.",
    );
  }

  console.log(
    d15Profile
      ? "\nUcus kontrolu tamam - private key yuklenmedi, transaction gonderilmedi."
      : "\nUcus kontrolu tamam - deploy edilebilir.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\nUcus kontrolu BASARISIZ: ${error.message ?? error}`);
    process.exit(1);
  });
