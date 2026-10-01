/**
 * Kuratorun zincirle konustugu tek yer.
 *
 * Iki sozlesmeye yazar:
 *   - VeriArfyRegistry.updateRoot : akredite agacin koku
 *   - AccreditationLog.accredit   : dogrulanmis taahhut + tekillik ozetleri
 *
 * TEK ISLEM KUYRUGU. Iki yazim da ayni cuzdandan gidiyor. Ayri kuyruklar
 * olsaydi ayni anda gelen bir onay ve bir kok yazimi ayni nonce'u alir, biri
 * duserdi. Butun yazimlar bu yuzden tek bir zincire diziliyor.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ethers } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));

const REGISTRY_ABI = [
  "function updateRoot(uint256 newRoot)",
  "function currentRoot() view returns (uint256)",
  "function owner() view returns (address)",
];

const LOG_ABI = [
  "function accredit(uint256 commitment, bytes32 emailKey, bytes32 profileKey, uint8 evidence)",
  "function identityUsed(bytes32) view returns (bool)",
  "function commitmentUsed(uint256) view returns (bool)",
  "function commitmentCount() view returns (uint256)",
  "function commitmentsFrom(uint256 start, uint256 count) view returns (uint256[])",
  "function owner() view returns (address)",
];

function loadDeployment() {
  // Uctan uca testte yerel bir dugume dagitilan adresleri gostermek icin.
  const path =
    process.env.CURATOR_DEPLOYMENT_FILE ??
    join(__dirname, "..", "..", "contracts", "deployments", "sepolia.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

export function connect() {
  const deployment = loadDeployment();
  const rpc = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
  // ONBELLEK KAPALI. ethers ayni istekleri kisa bir sure (250 ms) onbellekte
  // tutuyor. Kuyruk iki yazimi dogru siraya diziyor ama ikincisi "siradaki
  // nonce" sorusunu onbellekten eski cevapla aliyordu: onay zincire yaziliyor,
  // hemen ardindaki kok yazimi "nonce too low" ile dusuyordu. Sonucu: kisi
  // listede ama kok eski - ZK kaydi basarisiz. Uctan uca testte yakalandi.
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
  const key = process.env.CURATOR_PRIVATE_KEY;
  const wallet = key ? new ethers.Wallet(key, provider) : null;

  const registryAddress = deployment?.contracts?.VeriArfyRegistry ?? null;
  const logAddress = deployment?.contracts?.AccreditationLog ?? null;

  const registry = registryAddress
    ? new ethers.Contract(registryAddress, REGISTRY_ABI, wallet ?? provider)
    : null;
  const log = logAddress ? new ethers.Contract(logAddress, LOG_ABI, wallet ?? provider) : null;

  if (!wallet) console.log("CURATOR_PRIVATE_KEY yok - zincire yazilmayacak.");
  if (!log) console.log("AccreditationLog adresi yok - dogrulama akisi kapali.");
  if (wallet) console.log(`Kurator cuzdani: ${wallet.address}`);

  let queue = Promise.resolve();
  function enqueue(task) {
    const next = queue.catch(() => {}).then(task);
    queue = next.catch(() => {});
    return next;
  }

  async function ensureOwner(contract, label) {
    const owner = await contract.owner();
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error(`${label} sahibi bu cuzdan degil (sahip ${owner})`);
    }
  }

  return {
    canWrite: Boolean(wallet),
    verificationReady: Boolean(wallet && log),
    registry,
    log,

    /** Listeyi zincirden, onay sirasiyla okur. */
    async loadCommitments() {
      if (!log) return [];
      const total = Number(await log.commitmentCount());
      const out = [];
      const PAGE = 200;
      for (let start = 0; start < total; start += PAGE) {
        const page = await log.commitmentsFrom(start, PAGE);
        for (const c of page) out.push(BigInt(c));
      }
      return out;
    },

    async isUsed(identityKey) {
      return log ? Boolean(await log.identityUsed(identityKey)) : false;
    },

    async isListed(commitment) {
      return log ? Boolean(await log.commitmentUsed(commitment)) : false;
    },

    accredit(commitment, emailKey, profileKey, evidence) {
      return enqueue(async () => {
        if (!wallet || !log) throw new Error("dogrulama akisi yapilandirilmadi");
        await ensureOwner(log, "AccreditationLog");
        const tx = await log.accredit(commitment, emailKey, profileKey, evidence);
        console.log(`Onay gonderildi: ${tx.hash}`);
        await tx.wait();
        return tx.hash;
      });
    },

    /** Koku yazar; zaten guncelse islem gondermez. Basarisizlikta false doner. */
    pushRoot(root) {
      if (!wallet || !registry) return Promise.resolve(false);
      return enqueue(async () => {
        if ((await registry.currentRoot()) === root) return true;
        await ensureOwner(registry, "Registry");
        const tx = await registry.updateRoot(root);
        console.log(`Kok yazimi gonderildi: ${tx.hash}`);
        await tx.wait();
        console.log(`Kok zincire yazildi: ${root}`);
        return true;
      }).catch((err) => {
        console.error("Kok yazimi basarisiz:", err.message);
        return false;
      });
    },
  };
}
