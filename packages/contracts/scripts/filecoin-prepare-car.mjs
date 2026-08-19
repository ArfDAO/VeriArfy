/**
 * Filecoin anlasmasi icin veri hazirligi — rapor §2.9.2.
 *
 * Yaptigi is:
 *   1. sifreli blob'u UnixFS CAR arsivine cevirir,
 *   2. commP'yi (piece CID) ve piece boyutunu hesaplar,
 *   3. CAR'i Pinata'ya yukler ve saglayicinin indirebilecegi genel URL uretir,
 *   4. cikti olarak `filecoin/deal-input.json` yazar.
 *
 * # Neden ESM (.mjs)
 *
 * `@ipld/car`, `ipfs-unixfs-importer` ve `@web3-storage/data-segment` yalnizca
 * ESM yayinlanir; hardhat betikleri ise CJS kosar ve ts-node dinamik
 * `import()`'u `require`'a indirger. Iki dunya bir dosyada birlesmiyor, bu
 * yuzden hazirlik ayri kosar ve sonucu JSON ile devreder.
 *
 * # Neden Pinata
 *
 * Depolama saglayicisi CAR'i bir HTTP adresinden ceker (`location_ref`).
 * Pinata JWT'si zaten depoda tanimli oldugu icin ek bir hesap gerekmez.
 * DIKKAT: burada Pinata bir Filecoin saglayicisi degildir, yalnizca CAR'in
 * indirilebildigi gecici bir kaynaktir. Kalicilik Filecoin anlasmasindan
 * gelir.
 *
 * Kullanim:
 *   node scripts/filecoin-prepare-car.mjs [dosya]
 *
 * Dosya verilmezse yeni bir sentetik sifreli blob uretilir.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CarWriter } from "@ipld/car";
import { CID } from "multiformats/cid";
import { MemoryBlockstore } from "blockstore-core/memory";
import { importer } from "ipfs-unixfs-importer";
import { Piece } from "@web3-storage/data-segment";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "filecoin");

/** Kokteki .env — Pinata JWT oradadir. */
function loadEnv() {
  if (process.env.PINATA_JWT) return;
  const envPath = join(HERE, "..", "..", "..", ".env");
  try {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // .env yoksa asagida acik hata verilir.
  }
}

/**
 * Blok icerigini duz `Uint8Array`'e cevirir.
 *
 * Yeni ipfs/blockstore surumleri blok icerigini `Uint8ArrayList` olarak verir
 * (kopyalamadan birlestirme icin). `CarWriter` ise duz `Uint8Array` bekler ve
 * aksi halde "Can only write {cid, bytes} objects" der — hata mesaji nesnenin
 * BICIMINI suclar ama sorun bayt tipidir, bu yuzden yaniltici.
 */
function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value?.subarray === "function") return value.subarray();
  throw new Error(`Beklenmeyen blok icerigi tipi: ${value?.constructor?.name}`);
}

/** Baytlari UnixFS CAR arsivine cevirir. */
async function toCar(bytes) {
  const blockstore = new MemoryBlockstore();

  // Bloklar `getAll()` ile DEGIL, yazilirken yakalanir.
  //
  // Sebep: bu blockstore surumunde `getAll()` beklenen `{cid, bytes}` cifti
  // yerine icerigi tembel bir uretici olarak veriyor ve CarWriter bunu
  // reddediyor. `put`'u sarmalamak hem CID'i hem baytlari dogru tipte,
  // yazildiklari anda verir — ayrica blok SIRASI da korunur.
  const blocks = [];
  const originalPut = blockstore.put.bind(blockstore);
  blockstore.put = async (cid, content, options) => {
    blocks.push({ cid, bytes: toBytes(content) });
    return originalPut(cid, content, options);
  };

  let rootCid;
  for await (const entry of importer(
    [{ path: "veriarfy-blob.bin", content: bytes }],
    blockstore,
    { cidVersion: 1, rawLeaves: true },
  )) {
    rootCid = entry.cid;
  }
  if (!rootCid) throw new Error("CAR koku olusmadi");

  const { writer, out } = CarWriter.create([CID.parse(rootCid.toString())]);
  const chunks = [];
  const collecting = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();

  // CID nesnesi YENIDEN AYRISTIRILIR: blockstore ile `@ipld/car` farkli
  // `multiformats` kopyalarina bagli olabilir (npm agacinda ikili paket
  // sorunu) ve o durumda CarWriter'in `CID.asCID(...)` kontrolu, nesne dogru
  // olsa bile basarisiz olur.
  for (const block of blocks) {
    await writer.put({
      cid: CID.parse(block.cid.toString()),
      bytes: block.bytes,
    });
  }
  await writer.close();
  await collecting;

  return { rootCid, car: Buffer.concat(chunks) };
}

/** CAR'i Pinata'ya yukler; saglayicinin cekecegi genel URL doner. */
async function uploadToPinata(car, name) {
  if (!process.env.PINATA_JWT) {
    throw new Error("PINATA_JWT tanimli degil — kokteki .env okunamadi.");
  }

  const form = new FormData();
  form.append("file", new Blob([car], { type: "application/vnd.ipld.car" }), name);
  form.append("pinataMetadata", JSON.stringify({ name }));
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

  const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.PINATA_JWT}` },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`Pinata ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const body = await response.json();
  const cid = body.IpfsHash ?? body.cid;
  if (!cid) throw new Error("Pinata yanitinda CID yok");
  return cid;
}

async function main() {
  loadEnv();

  const inputPath = process.argv[2];
  const blob = inputPath
    ? readFileSync(inputPath)
    : Buffer.concat([
        Buffer.from("VERIARFY-SIFRELI-PANEL-V1\n"),
        randomBytes(64 * 1024),
      ]);

  console.log(`Blob        : ${blob.length} bayt${inputPath ? ` (${inputPath})` : " (sentetik)"}`);

  const { rootCid, car } = await toCar(blob);
  console.log(`CAR koku    : ${rootCid}`);
  console.log(`CAR boyutu  : ${car.length} bayt`);

  // commP — Filecoin'in anlasmada kullandigi "piece" kimligi. CAR'in
  // ICERIGINDEN turer; yani sonradan degistirilirse anlasma tutmaz.
  //
  // DIKKAT — IKI FARKLI PIECE CID VAR:
  //   `piece.link`            -> v2 bicimi (bafkzcib...), yeni araclar
  //   `Piece.toInfo(p).link`  -> v1 commP  (baga6ea4seaq...), MARKET AKTORU
  //
  // Anlasma teklifi v1 ister. v2 gonderilirse teklif sessizce reddedilir.
  const piece = Piece.fromPayload(car);
  const info = Piece.toInfo(piece);
  const pieceCid = info.link.toString();
  const pieceSize = Number(info.size);

  console.log(`piece CID   : ${pieceCid}`);
  console.log(`piece boyutu: ${pieceSize} bayt (2'nin kuvveti, dolgulu)`);

  const carCid = await uploadToPinata(car, `veriarfy-${rootCid}.car`);
  const gateway = process.env.VITE_IPFS_GATEWAY ?? "https://gateway.pinata.cloud/ipfs";
  const carUrl = `${gateway}/${carCid}`;
  console.log(`CAR adresi  : ${carUrl}`);

  // Saglayicinin gercekten indirebildigini SIMDI dogrula. Indiremezse
  // anlasma teklifi sessizce cope gider ve 24 saat bosuna beklenir.
  //
  // Yeni pinlenen bir CID genel ag gecidinde hemen gorunmez; ilk istekler
  // 404 doner. Ustel bekleme ile denenir — bu bir hata degil, yayilma suresi.
  let fetched = null;
  for (let attempt = 0; attempt < 7 && !fetched; attempt++) {
    if (attempt > 0) {
      const waitMs = 2_000 * 2 ** (attempt - 1);
      console.log(`  ag gecidi henuz yaymadi, ${waitMs / 1000} sn bekleniyor...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    const probe = await fetch(carUrl, { method: "GET" });
    if (probe.ok) fetched = Buffer.from(await probe.arrayBuffer());
  }

  if (!fetched) {
    throw new Error(`CAR genel adresten indirilemedi — teklif bosa giderdi: ${carUrl}`);
  }
  if (!fetched.equals(car)) {
    throw new Error(`Genel adresten inen CAR farkli: ${fetched.length} vs ${car.length} bayt`);
  }
  console.log(`Indirme     : dogrulandi, ${fetched.length} bayt birebir ayni`);

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, "deal-input.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        rootCid: rootCid.toString(),
        pieceCid,
        // Sozlesme piece CID'i DIZE olarak degil HAM BAYT olarak ister
        // (`bytes piece_cid`). Base32 dizesini zincirde cozmek gereksiz is
        // olurdu; burada bir kez cikarilir.
        pieceCidHex: `0x${Buffer.from(CID.parse(pieceCid).bytes).toString("hex")}`,
        pieceSize,
        carSize: car.length,
        carUrl,
        carCid,
        blobSize: blob.length,
        preparedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`\nYazildi     : ${outPath}`);
}

main().catch((err) => {
  console.error(`\nHazirlik basarisiz: ${err.message}`);
  process.exit(1);
});
