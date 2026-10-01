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

import { evaluateDifferencing, evaluateRequest } from "./policy.js";

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
  "function disclosureSnpIds(uint256) view returns (uint32[])",
  "function disclosureMetricIds(uint256) view returns (uint32[])",
  "function snpCoverageCount(uint32) view returns (uint32)",
  "function biomarkerModule() view returns (address)",
  "event DisclosureRequested(uint256 indexed requestId, address indexed requester, uint32 snapshotCount)",
];
const BIOMARKER_ABI = ["function metricCoverageCount(uint32) view returns (uint32)"];
const STAKING_ABI = [
  "function canApprove(address) view returns (bool)",
  // Saglik raporu icin: teminatin esige gore NEREDE oldugunu gostermek,
  // yalnizca "yetersiz" demekten cok daha kullanisli.
  "function stakeOf(address) view returns (uint256)",
  "function minStake() view returns (uint256)",
];

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
const state = { lastScan: null, lastError: null, approved: [], skipped: 0, readiness: [], rejected: {} };

/**
 * Dugumlerin onay VEREBILIR durumda olup olmadigini olcer.
 *
 * NEDEN SAGLIK UCUNDA: teminat esigi (`minStake`) havuzun toplam degeriyle
 * birlikte buyuyor. Sabit bir teminat bir sure sonra esigin altinda kaliyor
 * ve dugum sessizce `canApprove=false` oluyor. O anda servis calisiyor, tarama
 * basarili, `lastError` bos - yani DISARIDAN SAGLIKLI GORUNUYOR, ama hicbir
 * talebi onaylayamiyor. Tam olarak bu yasandi.
 *
 * Calisir gorunmek ile calismak arasindaki farki gosteren tek sey bu alan.
 */
async function measureReadiness() {
  const rows = [];
  let required = null;
  try {
    required = await staking.minStake();
  } catch {
    /* esik okunamadi; asagida null olarak raporlanir */
  }

  for (const wallet of wallets) {
    try {
      const [authorized, staked, approves, gas] = await Promise.all([
        readProtocol.isAuthorizedNode(wallet.address),
        staking.stakeOf(wallet.address),
        staking.canApprove(wallet.address),
        provider.getBalance(wallet.address),
      ]);
      rows.push({
        node: wallet.address,
        authorized,
        canApprove: approves,
        stake: ethers.formatEther(staked),
        requiredStake: required === null ? null : ethers.formatEther(required),
        gas: ethers.formatEther(gas),
        // Gaz bitince onay islemi gonderilemez; teminat yeterli olsa bile
        // servis durur. Esik dusuk ama sifirdan buyuk olmali.
        lowGas: gas < ethers.parseEther("0.002"),
      });
    } catch (error) {
      rows.push({ node: wallet.address, error: error.shortMessage ?? error.message });
    }
  }
  state.readiness = rows;
}

// Ayni cuzdanin iki islemi ayni nonce'u almasin diye cuzdan basina siraya dizilir.
const chains = new Map(wallets.map((w) => [w.address, Promise.resolve()]));

function queue(wallet, task) {
  const next = (chains.get(wallet.address) ?? Promise.resolve()).catch(() => {}).then(task);
  chains.set(wallet.address, next);
  return next;
}

/* ---------------------------------------------------------------------------
 * Talep anindaki alan sayimlari (fark saldirisi kontrolu icin)
 *
 * Her talep, acildigi bloktaki tabloyu dondurur. O bloktaki alan bazli kisi
 * sayisi, dondurulan tablonun kac kisiyi icerdigidir. Sayaclar yalnizca
 * arttigi icin bu deger o blokta okunarak TAM olarak bulunur ve bir daha
 * degismez - bu yuzden onbellege alinir.
 * ------------------------------------------------------------------------- */

const requestBlocks = new Map(); // requestId -> blok
const fieldCounts = new Map(); // requestId -> [{key, count}]
let logsScannedTo = Number(deployment.deployedAtBlock ?? 0) - 1;
const LOG_CHUNK = 5_000;

/** DisclosureRequested olaylarindan talep -> blok eslemesini gunceller. */
async function refreshRequestBlocks() {
  const head = await provider.getBlockNumber();
  while (logsScannedTo < head) {
    const from = logsScannedTo + 1;
    const to = Math.min(head, from + LOG_CHUNK - 1);
    const logs = await readProtocol.queryFilter("DisclosureRequested", from, to);
    for (const log of logs) requestBlocks.set(Number(log.args.requestId), log.blockNumber);
    logsScannedTo = to;
  }
}

let biomarkers = null;
async function getBiomarkers() {
  if (biomarkers !== null) return biomarkers;
  const address = await readProtocol.biomarkerModule();
  biomarkers = address === ethers.ZeroAddress ? false : new ethers.Contract(address, BIOMARKER_ABI, provider);
  return biomarkers;
}

async function countsAt(requestId) {
  if (fieldCounts.has(requestId)) return fieldCounts.get(requestId);

  const block = requestBlocks.get(requestId);
  if (block === undefined) throw new Error(`talep ${requestId} icin acilis blogu bulunamadi`);

  const [snpIds, metricIds] = await Promise.all([
    readProtocol.disclosureSnpIds(requestId),
    readProtocol.disclosureMetricIds(requestId),
  ]);

  const fields = [];
  for (const id of snpIds) {
    const count = await readProtocol.snpCoverageCount(id, { blockTag: block });
    fields.push({ key: `snp:${id}`, count: Number(count) });
  }
  const module = await getBiomarkers();
  if (module) {
    for (const id of metricIds) {
      const count = await module.metricCoverageCount(id, { blockTag: block });
      fields.push({ key: `metric:${id}`, count: Number(count) });
    }
  }

  fieldCounts.set(requestId, fields);
  return fields;
}

/**
 * Talebi, iptal edilmemis diger TUM taleplerle karsilastirir.
 *
 * Henuz yurutulmemis talepler de dahildir: onay geri alinamaz bir yurutmeye
 * giden yolu acar, yani "su an yetki verilmis olanlar" yetmez.
 */
async function differencingVerdict(requestId, total, minParticipants) {
  await refreshRequestBlocks();
  const mine = await countsAt(requestId);

  const others = [];
  for (let id = 0; id < total; id++) {
    if (id === requestId) continue;
    if (await readProtocol.isDisclosureRevoked(id)) continue;
    others.push({ requestId: id, fields: await countsAt(id) });
  }

  return evaluateDifferencing({ fields: mine }, others, minParticipants);
}

async function considerRequest(requestId) {
  const minParticipants = Number(await readProtocol.minParticipants());

  // Fark saldirisi kontrolu dugum basina degil TALEP basina yapilir: sonuc
  // hangi dugumun onaylayacagina bagli degil.
  const total = Number(await readProtocol.nextRequestId());
  const differencing = await differencingVerdict(requestId, total, minParticipants);
  if (!differencing.approve) {
    if (!state.rejected[requestId]) {
      console.log(`talep ${requestId}: REDDEDILDI - ${differencing.reason}`);
    }
    state.rejected[requestId] = { reason: differencing.reason, at: new Date().toISOString() };
    return;
  }
  delete state.rejected[requestId];

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
      // GONDERMEDEN HEMEN ONCE YENIDEN KONTROL.
      //
      // Karar, islem kuyruga girmeden ONCE okunan duruma dayaniyor. Kuyrukta
      // beklerken baska bir islem talebi sonuclandirmis olabilir; o durumda
      // islem zincirde revert eder ve gazi bosa gider. Bu bir kez yasandi:
      // dugumun nonce'u, basarili islemlerden bir fazlaydi.
      const [alreadyApproved, alreadyFinal] = await Promise.all([
        readProtocol.hasApproved(requestId, wallet.address),
        readProtocol.isDisclosureFinalized(requestId),
      ]);
      if (alreadyApproved || alreadyFinal) {
        console.log(`talep ${requestId} / ${wallet.address}: kuyrukta beklerken sonuclanmis - gonderilmedi`);
        return;
      }

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
let scanning = false;

async function scan() {
  // TARAMALAR UST USTE BINMEZ.
  //
  // Servis uyurken gelen ilk istek onu uyandiriyor ve acilis taramasi yavas
  // RPC ile yarim dakikayi asabiliyor. `setInterval` bu arada yeni bir tarama
  // baslatiyordu; ikisi de ayni talebi "onaysiz" gorup ikisi de onay
  // gonderiyordu - ikincisi revert edip gaz yakiyordu.
  if (scanning) return;
  scanning = true;
  try {
    const total = Number(await readProtocol.nextRequestId());
    for (let id = 0; id < total; id++) {
      const finalized = await readProtocol.isDisclosureFinalized(id);
      const revoked = await readProtocol.isDisclosureRevoked(id);
      if (finalized || revoked) continue;
      await considerRequest(id);
    }
    await measureReadiness();
    state.lastScan = new Date().toISOString();
    state.lastError = null;
  } catch (error) {
    state.lastError = error.shortMessage ?? error.message;
    console.error("tarama basarisiz:", state.lastError);
  } finally {
    scanning = false;
  }
}

await scan();
setInterval(() => void scan(), POLL_MS);

// Barindirilan ortamlar canli bir port bekler; ayrica servisin ne yaptigini
// disaridan gorebilmek gerekiyor.
createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });

  // GET /requests/:id - arayuz bekleyen bir talebin NEDEN onaylanmadigini
  // gosterebilsin. Aksi halde reddedilen talep "onay bekliyor" gorunumunde
  // sonsuza kadar kalir ve arastirmaci ne olduguna dair hicbir sey bilemez.
  const match = /^\/requests\/(\d+)$/.exec(req.url ?? "");
  if (match) {
    const id = Number(match[1]);
    const rejected = state.rejected[id] ?? null;
    const approved = state.approved.find((a) => a.requestId === id) ?? null;
    res.end(JSON.stringify({ requestId: id, rejected, approved, lastScan: state.lastScan }));
    return;
  }

  res.end(
    JSON.stringify({
      protocol: deployment.contracts.VeriarfyProtocol,
      nodes: wallets.map((w) => w.address),
      independentNodes: wallets.length === 1,
      pollMs: POLL_MS,
      // `lastError` bos olmasi yetmez: hicbir dugum onay veremiyorsa servis
      // hatasiz calisip hicbir ise yaramiyordur.
      canApproveAny: state.readiness.some((r) => r.canApprove === true),
      ...state,
    }),
  );
}).listen(PORT, () => console.log(`Dugum servisi http://localhost:${PORT} uzerinde dinliyor`));
