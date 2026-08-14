/**
 * IPFS yukleme vekili.
 *
 * Tarayici sifreli blobu buraya gonderir, Pinata'ya bu modul yukler. Boylece
 * Pinata JWT'si **hicbir zaman istemciye inmez**.
 *
 * Neden vekil sart: Vite/Next.js gibi bundler'lar `VITE_*` / `NEXT_PUBLIC_*`
 * degiskenlerini uretilen JS'e duz metin gomer. Boyle bir JWT gizli degildir;
 * siteyi acan herkes onu okuyup hesabiniza istedigini pinleyebilir.
 *
 * ## Bu vekil kimlik dogrulamiyor
 *
 * Su haliyle endpoint aciktir: adresini bilen herkes yukleyebilir. Yalnizca
 * boyut siniri ve basit bir hiz siniri var. Uretime cikmadan once bu projeye
 * dogal olan kontrolu ekleyin: katilimci zaten `/enroll` ile agacta oldugunu
 * ZK kaniti ureterek gosteriyor — ayni kanit burada da istenmeli.
 */

const PINATA_API_URL = process.env.PINATA_API_URL ?? "https://api.pinata.cloud";
const PINATA_JWT = process.env.PINATA_JWT;

/** Faz 2 olcumlerine gore 1000 varyantlik tohumlanmis panel ~0,5 MB. 25 MB genis bir tavan. */
const MAX_BYTES = Number(process.env.IPFS_MAX_BYTES ?? 25 * 1024 * 1024);

/** Kaba hiz siniri: IP basina pencere icinde en fazla N yukleme. */
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = Number(process.env.IPFS_RATE_LIMIT ?? 10);
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);

  // Bellegin sinirsiz buyumesini engelle.
  if (hits.size > 10_000) hits.clear();

  return recent.length > RATE_LIMIT;
}

/** Govdeyi bayt olarak, boyut sinirini asarsa erken keserek okur. */
async function readBytes(req, limit) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const error = new Error(`govde cok buyuk (> ${limit} bayt)`);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/** Metadata basliklarini dogrular. Pinata anahtar/deger olarak yalnizca string kabul eder. */
function parseMetadata(req) {
  const name = String(req.headers["x-pin-name"] ?? "Veriarfy_Panel_Blob").slice(0, 200);

  let keyvalues = {};
  const raw = req.headers["x-pin-keyvalues"];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      for (const [k, v] of Object.entries(parsed)) {
        // Pinata sayisal/boolean degerleri reddediyor; hepsini string'e cevir.
        keyvalues[String(k).slice(0, 64)] = String(v).slice(0, 256);
      }
    } catch {
      const error = new Error("x-pin-keyvalues gecerli JSON degil");
      error.status = 400;
      throw error;
    }
  }

  return { name, keyvalues };
}

/**
 * POST /ipfs/upload — govde: ham sifreli baytlar.
 *
 * Basliklar: `x-pin-name`, `x-pin-keyvalues` (JSON).
 * Yanit: `{ cid, size, pinnedAt }`.
 */
export async function handleUpload(req, res, json) {
  if (!PINATA_JWT) {
    return json(res, 503, {
      error: "PINATA_JWT tanimli degil — sunucu IPFS'e yukleyemez",
    });
  }

  const ip = req.socket.remoteAddress ?? "bilinmiyor";
  if (rateLimited(ip)) {
    // Retry-After: istemci kendi tahminini degil bu sureyi kullanir.
    return json(
      res,
      429,
      { error: "cok fazla istek, biraz sonra deneyin" },
      { "retry-after": String(Math.ceil(RATE_WINDOW_MS / 1000)) },
    );
  }

  let bytes;
  let metadata;
  try {
    bytes = await readBytes(req, MAX_BYTES);
    metadata = parseMetadata(req);
  } catch (error) {
    return json(res, error.status ?? 400, { error: error.message });
  }

  if (bytes.length === 0) {
    return json(res, 400, { error: "bos govde" });
  }

  const form = new FormData();
  form.append("file", new Blob([bytes]), `${metadata.name}.bin`);
  form.append("pinataMetadata", JSON.stringify(metadata));
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

  const response = await fetch(`${PINATA_API_URL}/pinning/pinFileToIPFS`, {
    method: "POST",
    // content-type ELLE VERILMEZ: FormData multipart sinirini kendi yazar.
    headers: { authorization: `Bearer ${PINATA_JWT}` },
    body: form,
  });

  const text = await response.text();

  if (!response.ok) {
    console.error(`Pinata ${response.status}: ${text.slice(0, 300)}`);
    // Pinata'nin durum kodunu aynen yansitiriz ki istemci tarafindaki
    // yeniden-deneme mantigi dogru karari verebilsin (5xx dene, 401 deneme).
    return json(res, response.status, {
      error: `Pinata yuklemeyi reddetti (${response.status})`,
    });
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json(res, 502, { error: "Pinata yaniti JSON degil" });
  }

  const cid = body.IpfsHash ?? body.cid ?? body.data?.cid;
  if (!cid) {
    return json(res, 502, { error: "Pinata yanitinda CID yok" });
  }

  console.log(`IPFS: ${bytes.length} bayt pinlendi -> ${cid}`);

  return json(res, 200, {
    cid,
    size: Number(body.PinSize ?? bytes.length),
    pinnedAt: body.Timestamp ?? new Date().toISOString(),
  });
}
