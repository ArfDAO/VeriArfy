/**
 * VeriArfyRegistry sahipligini kurator cuzdanina devreder.
 *
 * NEDEN: Arastirmaci kaydi, kuratorun Merkle kokunun zincirde guncel olmasini
 * gerektirir. `updateRoot` sadece sahibin cagirabildigi bir fonksiyon oldugu
 * icin, sahip bir insanin cuzdaniysa her yeni kayit elle islem gondermeyi
 * bekler. Sahiplik kurator servisinin cuzdanina gecince kok yazimi otomatiklesir.
 *
 * KAPSAM: Bu cuzdan YALNIZCA `updateRoot` cagirabilir. Registry'nin baska
 * yonetimsel fonksiyonu yok; Protocol, Payments ve diger kontratlarin
 * sahipligi degismez.
 *
 * Kullanim (registry sahibinin anahtariyla):
 *   NEW_REGISTRY_OWNER=0x... npx hardhat run scripts/transfer-registry-owner.ts --network sepolia
 */
import { ethers } from "hardhat";
import { readFileSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const newOwner = process.env.NEW_REGISTRY_OWNER;
  if (!newOwner || !ethers.isAddress(newOwner)) {
    throw new Error("NEW_REGISTRY_OWNER gecerli bir adres olmali.");
  }

  const deploymentPath = join(__dirname, "..", "deployments", "sepolia.json");
  const registryAddress = JSON.parse(readFileSync(deploymentPath, "utf8"))
    .contracts.VeriArfyRegistry as string;

  const [signer] = await ethers.getSigners();
  const registry = await ethers.getContractAt("VeriArfyRegistry", registryAddress);

  const owner = await registry.owner();
  console.log(`Registry      : ${registryAddress}`);
  console.log(`Mevcut sahip  : ${owner}`);
  console.log(`Imzalayan     : ${signer.address}`);
  console.log(`Yeni sahip    : ${newOwner}`);

  if (owner.toLowerCase() === newOwner.toLowerCase()) {
    console.log("Sahiplik zaten bu adreste - islem gonderilmedi.");
    return;
  }
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Bu cuzdan registry sahibi degil. Devri ${owner} adresinin yapmasi gerekiyor.`,
    );
  }

  const tx = await registry.transferOwnership(newOwner);
  console.log(`Gonderildi: ${tx.hash}`);
  await tx.wait();
  console.log(`Sahiplik devredildi. Yeni sahip: ${await registry.owner()}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
