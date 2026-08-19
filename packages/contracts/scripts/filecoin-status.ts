import { ethers, network } from "hardhat";

/**
 * Calibration hazirlik kontrolu — musluktan tFIL geldi mi?
 *
 * Kullanim:
 *   npx hardhat --config hardhat.filecoin.ts run scripts/filecoin-status.ts --network calibration
 *
 * Anlasma kurmadan once tek gereken sey bakiyedir; bu betik onu ve baglanti
 * ayarlarinin dogrulugunu tek bakista gosterir.
 */
async function main() {
  const [signer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  console.log(`Ag       : ${network.name} (chainId ${net.chainId})`);
  console.log(`Adres    : ${signer.address}`);

  if (net.chainId !== 314159n) {
    throw new Error(`Calibration bekleniyordu, baglanilan chainId: ${net.chainId}`);
  }

  const balance = await ethers.provider.getBalance(signer.address);
  console.log(`Bakiye   : ${ethers.formatEther(balance)} tFIL`);

  const head = await ethers.provider.getBlockNumber();
  console.log(`Zincir   : blok ${head}`);

  if (balance === 0n) {
    console.log("\nBakiye SIFIR. Anlasma kurmak icin musluktan tFIL alinmali:");
    console.log("  https://faucet.calibnet.chainsafe-fil.io");
    console.log("  https://beryx.zondax.ch/faucet");
    console.log(`\nMusluga verilecek adres: ${signer.address}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nBakiye yeterli — anlasma adimina gecilebilir.");
}

main().catch((err) => {
  console.error(`Basarisiz: ${err.message}`);
  process.exit(1);
});
