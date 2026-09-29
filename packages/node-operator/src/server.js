/**
 * Yetkili dugum servisi.
 *
 * NEDEN VAR: acilim talepleri kendiliginden onaylanmiyordu. Arastirmaci
 * ucreti oduyor, talep aciliyor ve `finalized=false, approvals=0` olarak
 * asili kaliyordu; onay ancak bir operator elle komut calistirinca geliyordu.
 * Kullanicinin satin aldigi seyi alabilmek icin birinin terminal acmasini
 * beklemesi kabul edilebilir bir akis degil - kurator kok yaziminda ayni
 * sorunu cozmustuk, bu onun ikizi.
 *
 * DURUSTLUK NOTU - BAGIMSIZLIK
 *
 * M-of-N onay modeli dugumlerin BAGIMSIZ olmasini varsayar. Bu servis, elinde
 * birden fazla dugum anahtari varsa hepsi adina onay verir; yani o dugumler
 * pratikte tek bir taraftir ve esik gercek bir dagitimi temsil etmez. Testnet
 * icin bilincli bir kolaylik; uretimde her dugum AYRI kurumda, AYRI anahtarla
 * ve AYRI politikayla calismalidir. Servis bunu gizlemez, acilista uyarir.
 *
 * NE YAPMAZ: talebin bilimsel degerini degerlendirmez (bkz. policy.js).
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { ethers } from "ethers";

import { evaluateRequest } from "./policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", "..", "..", ".env") });

const PORT = Number(process.env.NODE_OPERATOR_PORT ?? 8788);
const POLL_MS = Number(process.env.NODE_OPERATOR_POLL_MS ?? 20_000);
const RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

const PROTOCOL_ABI = [
  "function approveDisclosure(uint256 requestId)",
  "function disclosureRequest(uint256) view returns (address requester, uint32 snapshotCount, uint64 requestedAt, bool finalized, uint256 approvals)",
  "function isDisclosureFinalized(uint256) view returns (bool)",
  "function isDisclosureRevoked(uint256) view returns (bool)",
  "function isDisclosureGranted(uint256) view returns (bool)",
  "function isAuthorizedNode(address) view returns (bool)",
  "function hasApproved(uint256, address) view returns (bool)",
  "function minParticipants() view returns (uint32)",
  "function nextRequestId() view returns (uint256)",
];
const STAKING_ABI = ["function canApprove(address) view returns (bool)"];

function loadNodeKeys() {
  // Barindirilan ortamda dosya yok; anahtarlar ortam degiskeninden gelir.
  const inline = process.env.NODE_PRIVATE_KEYS;
  if (inline) {
    return inline.split(",").map((k) => k.trim()).filter(Boolean);
  }

  const path = process.env.NODE_WALLETS;
  if (path && existsSync(path)) {
    const { nodes } = JSON.parse(readFileSync(path, "utf8"));
    return (nodes ?? []).map((n) => n.privateKey);
  }

  return [];
}

function loadDeployment() {
  const path = join(__dirname, "..", "..", "contracts", "deployments", "sepolia.json");
  if (!existsSync(path)) throw new Error(`Deploy dosyasi yok: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

const deployment = loadDeployment();
const provider = new ethers.JsonRpcProvider(RPC);
const keys = loadNodeKeys();

if (keys.length === 0) {
  console.error(
    "Dugum anahtari yok. NODE_PRIVATE_KEYS (virgulle ayrilmis) ya da " +
      "NODE_WALLETS (dosya yolu) tanimlayin.",
  );
  process.exit(1);
}

const wallets = keys.map((key) => new ethers.Wallet(key, provider));
const readProtocol = new ethers.Contract(deployment.contracts.VeriarfyProtocol, PROTOCOL_ABI, provider);
const staking = new ethers.Contract(deployment.contracts.VeriarfyStaking, STAKING_ABI, provider);

console.log(`Protokol : ${deployment.contracts.VeriarfyProtocol}`);
for (const wallet of wallets) console.log(`Dugum    : ${wallet.address}`);
if (wallets.length > 1) {
  console.warn(
    `UYARI: ${wallets.length} dugum TEK proseste calisiyor. M-of-N esigi ` +
      "bagimsiz taraflari varsayar; burada varsayilmiyor. Uretimde her dugum " +
      "ayri kurumda, ayri anahtarla calismalidir.",
  );
}

/** Son onay denemesinin sonucu - saglik ucu bunu gosterir. */
const state = { lastScan: null, lastError: null, approved: [], skipped: 0 };

// Ayni cuzdanin iki islemi ayni nonce'u almasin diye cuzdan basina siraya dizilir.
const chains = new Map(wallets.map((w) => [w.address, Promise.resolve()]));

function queue(wallet, task) {
  const next = (chains.get(wallet.address) ?? Promise.resolve()).catch(() => {}).then(task);
  chains.set(wallet.address, next);
  return next;
}

async function considerRequest(requestId) {
  const minParticipants = Number(await readProtocol.minParticipants());

  for (const wallet of wallets) {
    // Her dugum icin durum YENIDEN okunur: onceki dugumun onayi talebi
    // sonuclandirmis olabilir, o halde ikinci islem bosuna gaz yakar.
    const [info, finalized, revoked, executed, authorized, approved, staked] = await Promise.all([
      readProtocol.disclosureRequest(requestId),
      readProtocol.isDisclosureFinalized(requestId),
      readProtocol.isDisclosureRevoked(requestId),
      readProtocol.isDisclosureGranted(requestId),
      readProtocol.isAuthorizedNode(wallet.address),
      readProtocol.hasApproved(requestId, wallet.address),
      staking.canApprove(wallet.address),
    ]);

    const verdict = evaluateRequest({
      requestId,
      requester: info.requester,
      snapshotCount: Number(info.snapshotCount),
      minParticipants,
      finalized,
      revoked,
      executed,
      isAuthorizedNode: authorized,
      hasApproved: approved,
      canApprove: staked,
    });

    if (!verdict.approve) {
      state.skipped += 1;
      console.log(`talep ${requestId} / ${wallet.address}: atlandi - ${verdict.reason}`);
      // Talep zaten sonuclandiysa diger dugumleri denemenin anlami yok.
      if (finalized || revoked || executed) return;
      continue;
    }

    await queue(wallet, async () => {
      const contract = new ethers.Contract(deployment.contracts.VeriarfyProtocol, PROTOCOL_ABI, wallet);
      const tx = await contract.approveDisclosure(requestId);
      console.log(`talep ${requestId} / ${wallet.address}: onay gonderildi ${tx.hash} (${verdict.reason})`);
      await tx.wait();
      state.approved.push({ requestId, node: wallet.address, hash: tx.hash, at: new Date().toISOString() });
      if (state.approved.length > 50) state.approved.shift();
      console.log(`talep ${requestId}: onaylandi`);
    });

    // Esige ulasildiysa fazladan onay gaz israfidir.
    if (await readProtocol.isDisclosureFinalized(requestId)) return;
  }
}

/**
 * Bekleyen tum talepleri tarar.
 *
 * Olay dinlemek yerine tarama yapiliyor: servis kapaliyken gelen talepler
 * olay akisinda kaybolur, tarama ise yeniden baslayinca onlari da bulur.
 * Sayac kucuk oldugu icin maliyeti onemsiz.
 */
async function scan() {
  try {
    const total = Number(await readProtocol.nextRequestId());
    for (let id = 0; id < total; id++) {
      const finalized = await readProtocol.isDisclosureFinalized(id);
      const revoked = await readProtocol.isDisclosureRevoked(id);
      if (finalized || revoked) continue;
      await considerRequest(id);
    }
    state.lastScan = new Date().toISOString();
    state.lastError = null;
  } catch (error) {
    state.lastError = error.shortMessage ?? error.message;
    console.error("tarama basarisiz:", state.lastError);
  }
}

await scan();
setInterval(() => void scan(), POLL_MS);

// Barindirilan ortamlar canli bir port bekler; ayrica servisin ne yaptigini
// disaridan gorebilmek gerekiyor.
createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(
    JSON.stringify({
      protocol: deployment.contracts.VeriarfyProtocol,
      nodes: wallets.map((w) => w.address),
      independentNodes: wallets.length === 1,
      pollMs: POLL_MS,
      ...state,
    }),
  );
}).listen(PORT, () => console.log(`Dugum servisi http://localhost:${PORT} uzerinde dinliyor`));
