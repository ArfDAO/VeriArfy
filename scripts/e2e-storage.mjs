/**
 * Uctan uca depolama dogrulamasi: sifrele -> IPFS -> CID -> zincir -> geri oku.
 *
 * # Bu betik neden var
 *
 * Depolama katmani bugune kadar yalnizca SAHTE bir Pinata'ya karsi test
 * edildi. Sahte sunucu, gercek servisin reddedecegi bir istegi kabul edebilir;
 * gercek CID'in gercekten cozulup cozulmedigini de gostermez. Bu betik zinciri
 * bastan sona gercek altyapida yurutur ve her adimi dogrular.
 *
 * # Ne yuklenir
 *
 * SENTETIK dozajlardan uretilmis GERCEK bir FHE sifreli metni. Icinde kisisel
 * veri yoktur ve zaten sifrelidir. IPFS herkese aciktir; bu yuzden buraya
 * asla gercek katilimci verisi konulmamalidir.
 *
 * # Adimlar
 *
 *   1. Rust sifreleyici sentetik bir paneli sifreler (tarayicinin yaptigi is).
 *   2. Curator vekili ayaga kalkar ve blob ona POST edilir.
 *      Vekil sart: Pinata JWT'si boylece istemciye hic inmez.
 *   3. Pinata bir CID dondurur.
 *   4. Ayni panel icin ZK koken kaniti uretilir (kurum imzasi + akreditasyon).
 *   5. CID'in multihash digest'i, kanitla birlikte zincire yazilir. Kontrat
 *      kaniti dogrulamadan kaydi kabul etmez.
 *   6. Blob IPFS gateway'inden geri cekilir ve BAYT BAYT karsilastirilir.
 *
 * Calistirma:
 *   node scripts/e2e-storage.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";
import { ethers } from "ethers";
import { CID } from "multiformats/cid";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Sentetik dozaj paneli (0 | 1 | 2). Gercek hasta verisi DEGILDIR.
 *
 * Uzunluk 16 olmak ZORUNDA: devre `DataProvenance(PANEL=16, ...)` olarak
 * derlendi ve farkli uzunlukta tanik uretilemez.
 */
const SYNTHETIC_DOSAGES = [0, 1, 2, 1, 0, 0, 2, 1, 1, 0, 2, 2, 0, 1, 0, 1];

const CURATOR_PORT = Number(process.env.CURATOR_PORT ?? 8787);
const GATEWAY = process.env.VITE_IPFS_GATEWAY ?? "https://gateway.pinata.cloud/ipfs";

const step = (n, text) => console.log(`\n[${n}] ${text}`);

/** Sunucunun dinlemeye baslamasini bekler; sonsuza kadar beklemez. */
async function waitForPort(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: "GET" });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`curator ${timeoutMs} ms icinde ayaga kalkmadi: ${url}`);
}

async function main() {
  if (!process.env.PINATA_JWT) {
    throw new Error("PINATA_JWT tanimli degil — kokteki .env okunamadi.");
  }

  // --- 1) Gercek FHE sifrelemesi -------------------------------------------
  step(1, "Sentetik panel sifreleniyor (gercek TFHE, gizli anahtar tarayicida)");

  const workDir = mkdtempSync(join(tmpdir(), "veriarfy-e2e-"));
  const encrypt = spawnSync(
    "cargo",
    ["run", "--release", "--quiet", "--example", "sk_encrypt", "--", workDir],
    {
      cwd: join(ROOT, "packages", "client-fhe-rust"),
      input: JSON.stringify({ values: SYNTHETIC_DOSAGES }),
      encoding: "utf8",
    },
  );
  if (encrypt.status !== 0) {
    throw new Error(`sifreleme basarisiz:\n${encrypt.stderr?.slice(-600)}`);
  }
  console.log(`    ${encrypt.stdout.trim()}`);

  // Panelin ilk sifreli metnini blob olarak kullaniyoruz; gercek akista
  // panelin tamami tek blob halinde yuklenir.
  const blobPath = join(workDir, "ct_0.bin");
  if (!existsSync(blobPath)) throw new Error("sifreli metin uretilmedi");
  const blob = readFileSync(blobPath);
  console.log(`    blob: ${(blob.length / 1024).toFixed(1)} KB`);

  // --- 2) Curator vekili ---------------------------------------------------
  step(2, "Curator vekili baslatiliyor (Pinata JWT istemciye inmez)");

  const curator = spawn("node", ["src/server.js"], {
    cwd: join(ROOT, "packages", "curator"),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  curator.stderr.on("data", (d) => process.stderr.write(`    [curator] ${d}`));

  let cid;
  try {
    const base = `http://127.0.0.1:${CURATOR_PORT}`;
    await waitForPort(`${base}/root`);
    console.log(`    dinliyor: ${base}`);

    // --- 3) Gercek Pinata yuklemesi ---------------------------------------
    step(3, "Blob Pinata'ya yukleniyor (GERCEK — IPFS herkese aciktir)");

    const response = await fetch(`${base}/ipfs/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-pin-name": "veriarfy-e2e-sentetik-panel",
        "x-pin-keyvalues": JSON.stringify({ kaynak: "e2e-testi", gercekVeri: "hayir" }),
      },
      body: blob,
    });

    const body = await response.json();
    if (!response.ok) {
      throw new Error(`yukleme reddedildi (${response.status}): ${JSON.stringify(body)}`);
    }

    cid = body.cid ?? body.IpfsHash;
    if (!cid) throw new Error(`yanitta CID yok: ${JSON.stringify(body)}`);
    console.log(`    CID: ${cid}`);
  } finally {
    curator.kill();
  }

  // --- 4) ZK koken kaniti uret ---------------------------------------------
  step(4, "ZK koken kaniti uretiliyor (kurum imzasi + akreditasyon)");

  const deployment = JSON.parse(
    readFileSync(join(ROOT, "packages", "contracts", "deployments", "sepolia.json"), "utf8"),
  );
  const address = deployment.contracts.VeriarfyProtocol;

  // Kontrat 32 baytlik multihash DIGEST'i saklar, CID metnini degil:
  // sabit boyut = ongorulebilir gas. CIDv1'in son 32 bayti sha2-256 ozetidir.
  const digest = ethers.hexlify(CID.parse(cid).multihash.digest);
  console.log(`    digest: ${digest}`);

  const provenance = await import("@veriarfy/circuits/provenance");
  const circuits = await import("@veriarfy/circuits");
  const snarkjs = await import("snarkjs");

  const { institution, registry } = await provenance.developmentRegistry();

  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const protocol = new ethers.Contract(
    address,
    [
      "function submitRecord(bytes32,uint256,uint256,uint256,uint256[2],uint256[2][2],uint256[2]) external",
      "function userCIDs(address) view returns (bytes32)",
      "function panelCommitment(address) view returns (uint256)",
      "function accreditedRoot() view returns (uint256)",
      "function PROVENANCE_SCOPE() view returns (uint256)",
    ],
    wallet,
  );

  // Yerel agacin koku zincirdekiyle ayni degilse kanit bosuna uretilir.
  const onChainRoot = await protocol.accreditedRoot();
  if (onChainRoot !== registry.root) {
    throw new Error(
      `akredite kok uyusmuyor:\n  zincir: ${onChainRoot}\n  yerel : ${registry.root}`,
    );
  }

  const scope = await protocol.PROVENANCE_SCOPE();
  const salt = provenance.randomSalt();
  const commitment = provenance.panelCommitment(SYNTHETIC_DOSAGES, salt);
  const signature = await provenance.signCommitment(institution.privateKey, commitment);

  const circuitsBuild = join(ROOT, "packages", "circuits", "build");
  const startedAt = Date.now();
  const { proof } = await snarkjs.groth16.fullProve(
    provenance.buildProvenanceInput({
      dosages: SYNTHETIC_DOSAGES,
      salt,
      institution,
      signature,
      registry,
      externalNullifier: scope,
      cidDigest: digest,
      signerAddress: wallet.address,
    }),
    join(circuitsBuild, "data_provenance_js", "data_provenance.wasm"),
    join(circuitsBuild, "data_provenance_final.zkey"),
  );
  const { a, b, c } = circuits.toSolidityCalldata(proof);
  console.log(`    kanit uretildi: ${Date.now() - startedAt} ms`);

  // --- 5) CID'i zincire yaz ------------------------------------------------
  step(5, "CID digest'i kanitla birlikte zincire yaziliyor");

  const tx = await protocol.submitRecord(
    digest,
    registry.root,
    provenance.computeProvenanceNullifier(scope, commitment),
    commitment,
    a,
    b,
    c,
  );
  const receipt = await tx.wait();
  console.log(`    hash: ${tx.hash}`);
  console.log(`    blok: ${receipt.blockNumber}  gas: ${receipt.gasUsed} (ZK dogrulama dahil)`);

  const stored = await protocol.userCIDs(wallet.address);
  if (stored !== digest) throw new Error(`zincirdeki digest uyusmuyor: ${stored}`);

  const storedCommitment = await protocol.panelCommitment(wallet.address);
  if (storedCommitment !== commitment) {
    throw new Error(`zincirdeki taahhut uyusmuyor: ${storedCommitment}`);
  }
  console.log("    zincirdeki digest ve panel taahhudu dogrulandi");

  // --- 5) IPFS'ten geri oku ------------------------------------------------
  step(6, "Blob IPFS gateway'inden geri cekiliyor ve bayt bayt karsilastiriliyor");

  // Iki AYRI dogrulama; birbirinin yerine gecmez:
  //
  //   (a) Pin kayitli mi — Pinata API'sine sorulur. Yetkili ve aninda kesin
  //       cevap verir: yukleme gercekten kabul edildi mi?
  //   (b) Icerik gateway'den okunabiliyor mu — yayilma (propagation) testi.
  //       Yeni pinlenen icerigin genel gateway'de gorunmesi zaman alir.
  //
  // Onceki surumde yalnizca (b) vardi ve 15 saniyede pes ediyordu; yayilma
  // bazen daha uzun suruyor ve basarili bir yukleme basarisiz gorunuyordu.

  const pinList = await fetch(
    `https://api.pinata.cloud/data/pinList?hashContains=${cid}&status=pinned`,
    { headers: { authorization: `Bearer ${process.env.PINATA_JWT}` } },
  );
  const pinBody = await pinList.json();
  if (!pinList.ok || (pinBody.count ?? 0) === 0) {
    throw new Error(`Pinata pini kaydetmemis: ${JSON.stringify(pinBody).slice(0, 200)}`);
  }
  console.log(`    Pinata pini onayladi (${pinBody.rows?.[0]?.size ?? "?"} bayt)`);

  // Ustel geri cekilme: 2, 4, 8, 16, 32, 60, 60... toplam ~3 dakika.
  let fetched = null;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const res = await fetch(`${GATEWAY}/${cid}`);
    lastStatus = res.status;
    if (res.ok) {
      fetched = Buffer.from(await res.arrayBuffer());
      break;
    }

    const waitMs = Math.min(2 ** attempt, 60) * 1000;
    console.log(`    deneme ${attempt}: HTTP ${res.status}, ${waitMs / 1000} sn bekleniyor...`);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  if (!fetched) {
    throw new Error(
      `blob gateway'den cekilemedi (son durum HTTP ${lastStatus}). ` +
        "Pin kayitli oldugu icin yukleme basarili; sorun gateway yayilmasinda.",
    );
  }
  if (!fetched.equals(blob)) {
    throw new Error(`geri okunan blob farkli: ${fetched.length} B vs ${blob.length} B`);
  }
  console.log(`    ${fetched.length} bayt, birebir ayni`);

  console.log("\nUCTAN UCA TAMAM: sifrele -> IPFS -> CID -> zincir -> geri oku");
  console.log(`  IPFS : ${GATEWAY}/${cid}`);
  console.log(`  Zincir: https://sepolia.etherscan.io/tx/${tx.hash}`);
}

// ACIK CIKIS SART.
//
// snarkjs, BN254 egri islemlerini worker thread'lerde yapar ve bunlari
// kendiliginden sonlandirmaz. `main()` bitse bile event loop bos kalmaz ve
// surec asili kalir. Piped calistirildiginda belirti yaniltici olur: cikti
// tampon icinde bekler, ekranda HICBIR SEY gorunmez ve is "takilmis" sanilir.
// Depodaki diger snarkjs betikleri de ayni sebeple acikca cikis yapar.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nUCTAN UCA BASARISIZ: ${err.message ?? err}`);
    process.exit(1);
  });
