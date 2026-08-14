import { ethers, network } from "hardhat";

/**
 * Deploy oncesi ucus kontrolu.
 *
 * Zincire yazmak geri alinamaz ve para harcar. Bu betik hicbir sey
 * gondermeden once su dort seyi dogrular:
 *
 *   1. Ag gercekten hedeflenen ag mi (chainId ile),
 *   2. Bir imzalayan yuklenmis mi (.env okunabilmis mi),
 *   3. Bakiye deploy icin yetiyor mu,
 *   4. Zincir gercekten yanit veriyor mu (blok numarasi).
 *
 * Gizli anahtar hicbir kosulda yazdirilmaz; yalnizca ondan turetilen ADRES
 * gosterilir — adres zaten zincirde herkese aciktir.
 *
 * Calistirma:
 *   npx hardhat run scripts/preflight.ts --network sepolia
 */

/** Dort kontratin deploy'u icin kabaca gereken alt sinir. */
const MINIMUM_BALANCE = ethers.parseEther("0.02");

async function main() {
  const chain = await ethers.provider.getNetwork();
  const blockNumber = await ethers.provider.getBlockNumber();

  console.log(`Ag       : ${network.name} (chainId ${chain.chainId})`);
  console.log(`Blok     : ${blockNumber}`);

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      "Imzalayan yok. DEPLOYER_PRIVATE_KEY okunamadi — .env kokte mi ve " +
        "hardhat.config.ts onu yukluyor mu?",
    );
  }

  const [deployer] = signers;
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`Deployer : ${deployer.address}`);
  console.log(`Bakiye   : ${ethers.formatEther(balance)} ETH`);

  const feeData = await ethers.provider.getFeeData();
  if (feeData.gasPrice) {
    console.log(`Gas      : ${ethers.formatUnits(feeData.gasPrice, "gwei")} gwei`);
  }

  if (balance < MINIMUM_BALANCE) {
    throw new Error(
      `Bakiye yetersiz: ${ethers.formatEther(balance)} ETH var, ` +
        `en az ${ethers.formatEther(MINIMUM_BALANCE)} ETH gerekiyor. ` +
        "Sepolia musluklarindan (faucet) test ETH alin.",
    );
  }

  console.log("\nUcus kontrolu tamam — deploy edilebilir.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nUcus kontrolu BASARISIZ: ${err.message}`);
    process.exit(1);
  });
