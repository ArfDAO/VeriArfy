/**
 * AccreditationLog'u dagitir ve adresini deployments/<ag>.json'a yazar.
 *
 * Sahip dogrudan KURATOR cuzdanidir (CURATOR_ADDRESS): listeye yazmak
 * kuratorun isi, dagitim anahtarinin degil. Mevcut sozlesmelerin hicbirine
 * dokunmaz.
 *
 * Kullanim:
 *   CURATOR_ADDRESS=0x... npx hardhat run scripts/deploy-accreditation-log.ts --network sepolia
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ethers, network } from "hardhat";

async function main() {
  const curator = process.env.CURATOR_ADDRESS;
  if (!curator || !ethers.isAddress(curator)) throw new Error("CURATOR_ADDRESS gecerli bir adres olmali");

  const path = join(__dirname, "..", "deployments", `${network.name}.json`);
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (record.contracts.AccreditationLog) {
    throw new Error(`AccreditationLog zaten kayitli: ${record.contracts.AccreditationLog}`);
  }

  const log = await (await ethers.getContractFactory("AccreditationLog")).deploy(curator);
  await log.waitForDeployment();
  const address = await log.getAddress();
  const receipt = await log.deploymentTransaction()!.wait();

  console.log(`AccreditationLog: ${address}`);
  console.log(`sahip           : ${await log.owner()}`);
  console.log(`blok            : ${receipt!.blockNumber}`);

  record.contracts.AccreditationLog = address;
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Adres yazildi: deployments/${network.name}.json`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
