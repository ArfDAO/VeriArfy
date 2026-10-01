/**
 * Kurator servisi.
 *
 * Akredite arastirmaci taahhutlerinin Merkle agacini tutar ve kanit uretmek icin
 * gereken yolu verir. GIZLI ANAHTAR GORMEZ - yalnizca acik taahhudu bilir.
 *
 * # Listeye kim girer
 *
 * Dogrulanmis arastirmacilar (bkz. verification/routes.js):
 *   - kurum e-postasi (.edu.tr) koduyla kutuya erisim, ve
 *   - ORCID ile giris (kurum ROR alan adiyla eslesir) ya da
 *     YOK Akademik / AVESIS profili (operator incelemesi).
 *
 * Dogrulama icin gereken hesaplar kurulana kadar test aginda ACIK KAYIT
 * surer (`/enroll`): taahhudunu gonderen listeye girer. Bu kayitlar dogrulanmis
 * listeye yazilmaz ve e-posta dogrulamasi yapilandirildigi anda acik kayit
 * kendiliginden kapanir (bkz. `openEnrollmentActive`).
 *
 * # Liste nerede tutulur
 *
 * ZINCIRDE (AccreditationLog). Sunucunun diski barindirildigi ortamda kalici
 * degil: her uykuda siliniyordu, liste depodaki ilk haline donuyor ve kok
 * zincire eski haliyle yeniden yaziliyordu. Agac artik her acilista zincirden
 * kurulur; sunucu kaybedebilecegi hicbir durum tutmaz.
 */
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { IdentityTree } from "@veriarfy/circuits";
import { connect } from "./chain.js";
import { handleUpload } from "./ipfs.js";
import { createVerificationRoutes, verificationStatus } from "./verification/routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Yerelde depo kokundeki `.env` okunur; Render'da degiskenler ortamdan gelir.
dotenv.config({ path: join(__dirname, "..", "..", "..", ".env") });

const PORT = Number(process.env.CURATOR_PORT ?? 8787);

const chain = connect();
const tree = new IdentityTree();
let size = 0;

/**
 * Agaci zincirdeki listeden kurar.
 *
 * Kok YALNIZCA liste sozlesmesi yapilandirilmissa yazilir. Aksi halde bos bir
 * agacin koku zincirdeki gecerli koku ezerdi - sozlesme henuz dagitilmamisken
 * servisin acilmasi bile kayitli olmayan herkesi kayit disi birakirdi.
 */
async function loadTree() {
  const commitments = await chain.loadCommitments();
  for (const c of commitments) tree.insert(c);
  size = commitments.length;
  console.log(`Kurator: zincirden ${size} dogrulanmis taahhut yuklendi. Kok: ${tree.root}`);
  if (chain.log) await chain.pushRoot(tree.root);
}

async function onAccredited(commitment) {
  if (tree.indexOf(commitment) === -1) {
    tree.insert(commitment);
    size += 1;
  }
  const pushed = await chain.pushRoot(tree.root);
  if (!pushed) throw new Error("taahhut listeye eklendi ama kok zincire yazilamadi; birazdan yeniden deneyin");
}

const handleVerification = createVerificationRoutes({ chain, onAccredited });

/**
 * ACIK KAYIT - dogrulama yapilandirilana kadar.
 *
 * Test aginda dogrulama icin gereken hesaplar (e-posta gonderimi, ORCID
 * istemcisi) henuz kurulmadi. O sure boyunca eski davranis surer: taahhudunu
 * gonderen listeye girer. Bu kayitlar DOGRULANMIS degildir ve zincirdeki
 * dogrulanmis listeye (AccreditationLog) YAZILMAZ - orada yanlis bir kanit
 * etiketiyle durmalari yaniltici olurdu. Yalnizca bellekteki agaca eklenir.
 *
 * E-posta dogrulamasi yapilandirildigi anda acik kayit KENDILIGINDEN KAPANIR.
 * `OPEN_ENROLLMENT=false` ile daha once de kapatilabilir.
 */
function openEnrollmentActive() {
  if (process.env.OPEN_ENROLLMENT === "false") return false;
  return !verificationStatus(chain).email;
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    // Tarayicidan gelen yukleme istegi bu ozel basliklari kullaniyor.
    "access-control-allow-headers": "content-type,x-pin-name,x-pin-keyvalues",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    // Retry-After varsayilan olarak JS'e gorunmez; acikca aciga cikarilmali.
    "access-control-expose-headers": "retry-after",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 64 * 1024) throw Object.assign(new Error("govde cok buyuk"), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});

    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (await handleVerification(req, res, url, { json, readBody })) return;

    // GET /root
    if (req.method === "GET" && url.pathname === "/root") {
      let chainRoot = null;
      try {
        chainRoot = chain.registry ? (await chain.registry.currentRoot()).toString() : null;
      } catch {
        chainRoot = null;
      }
      return json(res, 200, {
        root: tree.root.toString(),
        size,
        chainRoot,
        autoPush: chain.canWrite,
        verification: verificationStatus(chain),
        openEnrollment: openEnrollmentActive(),
      });
    }

    // POST /enroll { commitment } - dogrulamasiz (acik) kayit.
    //
    // Yalnizca acik kayit donemindeyken calisir. Dogrulama yapilandirildiktan
    // sonra kapalidir: acik kalsaydi dogrulama akisi bir susten ibaret olurdu,
    // herkes bu uctan dogrudan listeye girebilirdi.
    if (url.pathname === "/enroll") {
      if (!openEnrollmentActive()) {
        return json(res, 410, {
          error: "Dogrulamasiz kayit kapali. Kurum e-postasi ve ORCID / YOK Akademik ile dogrulama gerekiyor.",
        });
      }
      if (req.method !== "POST") return json(res, 405, { error: "POST gerekli" });
      const body = await readBody(req);
      let commitment;
      try {
        commitment = BigInt(body.commitment);
      } catch {
        return json(res, 400, { error: "gecersiz taahhut" });
      }
      if (commitment <= 0n) return json(res, 400, { error: "gecersiz taahhut" });

      let index = tree.indexOf(commitment);
      if (index === -1) {
        index = tree.insert(commitment);
        size += 1;
        console.log(`+ acik kayit: taahhut #${index}. Yeni kok: ${tree.root}`);
      }
      // Kok zincire yazilmadan uretilen kanit dogrulanmaz; yanit yazimi bekler.
      const pushed = await chain.pushRoot(tree.root);
      return json(res, 200, { index, root: tree.root.toString(), rootPending: !pushed });
    }

    // GET /path/:commitment
    if (req.method === "GET" && url.pathname.startsWith("/path/")) {
      let commitment;
      try {
        commitment = BigInt(url.pathname.slice("/path/".length));
      } catch {
        return json(res, 400, { error: "gecersiz taahhut" });
      }
      const index = tree.indexOf(commitment);
      if (index === -1) return json(res, 404, { error: "taahhut listede yok" });

      const proof = tree.proof(index);
      return json(res, 200, {
        index,
        siblings: proof.siblings.map(String),
        pathIndices: proof.pathIndices,
        root: tree.root.toString(),
      });
    }

    // POST /ipfs/upload - sifreli blobu Pinata'ya vekaleten yukler.
    // JWT burada kalir; istemciye hicbir zaman inmez.
    if (req.method === "POST" && url.pathname === "/ipfs/upload") {
      return handleUpload(req, res, json);
    }

    return json(res, 404, { error: "bulunamadi" });
  } catch (err) {
    console.error(err);
    return json(res, err.status ?? 500, { error: err.message });
  }
});

loadTree()
  .catch((err) => console.error("Liste zincirden yuklenemedi:", err.message))
  .finally(() => {
    server.listen(PORT, () => console.log(`Kurator http://localhost:${PORT} uzerinde dinliyor`));
  });
