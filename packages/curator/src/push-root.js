/**
 * Kuratorun agac kokunu zincire yazar.
 *
 * Kullanim:
 *   SEPOLIA_RPC_URL=... CURATOR_PRIVATE_KEY=... \
 *   npm run push-root --workspace packages/curator
 *
 * Kok guncellendikten sonra eski kok VeriArfyRegistry.ROOT_VALIDITY (1 saat)
 * boyunca gecerli kalir; boylece kanit ureten katilimcilar yarida kalmaz.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ethers } from "ethers";

import { IdentityTree } from "@veriarfy/circuits";

const __dirname = dirname(fileURLToPath(import.meta.url));
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
  const key = process.env.CURATOR_PRIVATE_KEY;
  if (!key) throw new Error("CURATOR_PRIVATE_KEY gerekli.");

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, wallet);

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
