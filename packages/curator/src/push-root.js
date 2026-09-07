/**
 * Kuratorun agac kokunu zincire yazar.
 *
 * Kullanim:
 *   npm run curator:push-root
 *
 * Anahtar depo kokundeki `.env` dosyasindan okunur; komut satirinda
 * yazmaya gerek yok (yazilirsa kabuk gecmisine duser).
 *
 * Kok guncellendikten sonra eski kok VeriArfyRegistry.ROOT_VALIDITY (1 saat)
 * boyunca gecerli kalir; boylece kanit ureten katilimcilar yarida kalmaz.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { ethers } from "ethers";

import { IdentityTree } from "@veriarfy/circuits";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Depo kokundeki `.env`. Betik onceden `process.env`'i dogrudan okuyordu ve
// `.env`'i hic yuklemiyordu; yani dosyaya anahtar yazmak ISE YARAMIYORDU ve
// tek yol komut satirinda vermekti — o da kabuk gecmisine duser.
dotenv.config({ path: join(__dirname, "..", "..", "..", ".env") });
const STORE = join(__dirname, "..", "data", "tree.json");
const DEPLOYMENT = join(
  __dirname,
  "..",
  "..",
  "contracts",
  "deployments",
  "sepolia.json",
);

const REGISTRY_ABI = [
  "function updateRoot(uint256 newRoot)",
  "function currentRoot() view returns (uint256)",
  "function owner() view returns (address)",
];

async function main() {
  if (!existsSync(STORE)) {
    throw new Error("Kurator agaci bos — once katilimci kaydi alin.");
  }
  if (!existsSync(DEPLOYMENT)) {
    throw new Error("Deploy dosyasi yok — once kontratlari deploy edin.");
  }

  const { commitments } = JSON.parse(readFileSync(STORE, "utf8"));
  const tree = new IdentityTree();
  for (const c of commitments) tree.insert(BigInt(c));

  const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
  const registryAddress = deployment.contracts.VeriArfyRegistry;

  const rpc = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
  // KURATOR = REGISTRY SAHIBI.
  //
  // Betik yalnizca `CURATOR_PRIVATE_KEY` ariyordu, oysa depodaki `.env`
  // `DEPLOYER_PRIVATE_KEY` tanimliyor ve registry'yi deploy eden o cuzdan
  // sahiplendi. Isim uyusmazligi yuzunden komut "CURATOR_PRIVATE_KEY
  // gerekli" deyip duruyordu — anahtar aslinda mevcuttu.
  //
  // Ayri bir kurator cuzdani kullanilacaksa `CURATOR_PRIVATE_KEY` hala
  // onceliklidir; asagidaki sahiplik kontrolu yanlis cuzdani zaten yakalar.
  const key = process.env.CURATOR_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "Anahtar yok. Depo kokundeki .env icinde CURATOR_PRIVATE_KEY ya da " +
        "DEPLOYER_PRIVATE_KEY tanimli olmali.",
    );
  }
  const keySource = process.env.CURATOR_PRIVATE_KEY ? "CURATOR_PRIVATE_KEY" : "DEPLOYER_PRIVATE_KEY";

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, wallet);

  console.log(`Anahtar kaynagi: ${keySource} (${wallet.address})`);

  const owner = await registry.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`Bu cuzdan kurator degil. Kontrat sahibi: ${owner}`);
  }

  const current = await registry.currentRoot();
  if (current === tree.root) {
    console.log("Kok zaten guncel:", tree.root.toString());
    return;
  }

  console.log(`Taahhut sayisi: ${commitments.length}`);
  console.log(`Eski kok: ${current}`);
  console.log(`Yeni kok: ${tree.root}`);

  const tx = await registry.updateRoot(tree.root);
  console.log(`Gonderildi: ${tx.hash}`);
  await tx.wait();
  console.log("Kok guncellendi.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
