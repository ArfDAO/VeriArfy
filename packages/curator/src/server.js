/**
 * Kurator servisi.
 *
 * Akredite katilimci taahhutlerinin Merkle agacini tutar ve kanit uretmek icin
 * gereken yolu verir. GIZLI ANAHTAR GORMEZ — yalnizca acik taahhudu bilir,
 * yani bir katilimcinin kim oldugunu ya da ne yanitladigini ogrenemez.
 *
 * Agacin koku zincire yazilmali; aksi halde kayit kaniti dogrulanmaz.
 * `CURATOR_PRIVATE_KEY` tanimliysa bu servis kokU KENDISI yazar, yani
 * kullanicinin hicbir komut calistirmasi gerekmez. Anahtar yoksa yedek yol:
 *   npm run push-root --workspace packages/curator
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { ethers } from "ethers";

import { IdentityTree } from "@veriarfy/circuits";
import { handleUpload } from "./ipfs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const STORE = join(DATA_DIR, "tree.json");

const PORT = Number(process.env.CURATOR_PORT ?? 8787);

// Yerelde depo kokundeki `.env` okunur; Render'da degiskenler ortamdan gelir.
dotenv.config({ path: join(__dirname, "..", "..", "..", ".env") });

/** Yalnizca taahhut listesi kalicidir; agac her acilista yeniden kurulur. */
function loadCommitments() {
  if (!existsSync(STORE)) return [];
  try {
    return JSON.parse(readFileSync(STORE, "utf8")).commitments ?? [];
  } catch {
    return [];
  }
}

function saveCommitments(list) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STORE, `${JSON.stringify({ commitments: list }, null, 2)}\n`);
}

const commitments = loadCommitments();
const tree = new IdentityTree();
for (const c of commitments) tree.insert(BigInt(c));

console.log(`Kurator: ${commitments.length} taahhut yuklendi.`);
console.log(`Kok: ${tree.root}`);

/* ---------------------------------------------------------------------------
 * Otomatik kok yazimi
 *
 * Kayit kaniti yalnizca zincirdeki kok agacla ayni oldugunda dogrulanir. Bu
 * eskiden elle `push-root` calistirmayi gerektiriyordu: kullanici siteye
 * kaydolur, kanit uretir ve "kok henuz yazilmadi" duvarina carpardi. Siteyi
 * kullanmak icin terminal komutu beklemek kabul edilebilir bir akis degil,
 * bu yuzden kok yazimi servise tasindi.
 *
 * `CURATOR_PRIVATE_KEY` tanimli DEGILSE servis eskisi gibi calisir; sadece
 * kok yazimi atlanir ve /enroll yanitinda `rootPending: true` doner, boylece
 * arayuz durumu durust bir sekilde gosterebilir.
 * ------------------------------------------------------------------------- */

const REGISTRY_ABI = [
  "function updateRoot(uint256 newRoot)",
  "function currentRoot() view returns (uint256)",
  "function owner() view returns (address)",
];

function buildRegistry() {
  const key = process.env.CURATOR_PRIVATE_KEY;
  if (!key) {
    console.log("CURATOR_PRIVATE_KEY yok - kok otomatik yazilmayacak.");
    return null;
  }

  const deploymentPath = join(
    __dirname, "..", "..", "contracts", "deployments", "sepolia.json",
  );
  if (!existsSync(deploymentPath)) {
    console.log("Deploy dosyasi yok - kok otomatik yazilmayacak.");
    return null;
  }

  try {
    const address = JSON.parse(readFileSync(deploymentPath, "utf8"))
      .contracts.VeriArfyRegistry;
    const rpc =
      process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
    const wallet = new ethers.Wallet(key, new ethers.JsonRpcProvider(rpc));
    console.log(`Kok yazici cuzdan: ${wallet.address} -> registry ${address}`);
    return new ethers.Contract(address, REGISTRY_ABI, wallet);
  } catch (err) {
    console.error("Registry baglanamadi:", err.message);
    return null;
  }
}

const registry = buildRegistry();

// Iki kayit ayni anda gelirse iki islem ayni nonce'u alir ve biri duser.
// Bu yuzden yazimlar tek bir zincire diziliyor.
let pushChain = Promise.resolve(true);

function queueRootPush(root) {
  if (!registry) return Promise.resolve(false);

  pushChain = pushChain
    .catch(() => false)
    .then(async () => {
      const current = await registry.currentRoot();
      if (current === root) return true;

      const owner = await registry.owner();
      const self = await registry.runner.getAddress();
      if (owner.toLowerCase() !== self.toLowerCase()) {
        console.error(`Kok yazilamadi: cuzdan sahip degil (sahip ${owner}).`);
        return false;
      }

      const tx = await registry.updateRoot(root);
      console.log(`Kok yazimi gonderildi: ${tx.hash}`);
      await tx.wait();
      console.log(`Kok zincire yazildi: ${root}`);
      return true;
    })
    .catch((err) => {
      console.error("Kok yazimi basarisiz:", err.message);
      return false;
    });

  return pushChain;
}

// Servis yeniden basladiginda agac ile zincir arasinda fark kalmis olabilir
// (onceki surum anahtarsiz calismis olabilir); acilista bir kez denkleriz.
if (registry && commitments.length > 0) {
  queueRootPush(tree.root);
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
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
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // GET /root
    if (req.method === "GET" && url.pathname === "/root") {
      let chainRoot = null;
      if (registry) {
        try {
          chainRoot = (await registry.currentRoot()).toString();
        } catch {
          chainRoot = null;
        }
      }
      return json(res, 200, {
        root: tree.root.toString(),
        size: commitments.length,
        chainRoot,
        autoPush: registry !== null,
      });
    }

    // POST /enroll { commitment }
    if (req.method === "POST" && url.pathname === "/enroll") {
      const body = await readBody(req);
      if (!body.commitment) return json(res, 400, { error: "commitment gerekli" });

      const commitment = BigInt(body.commitment);
      let index = tree.indexOf(commitment);

      if (index === -1) {
        index = tree.insert(commitment);
        commitments.push(commitment.toString());
        saveCommitments(commitments);
        console.log(`+ taahhut #${index} eklendi. Yeni kok: ${tree.root}`);
      }

      // Kok zincire yazilmadan uretilen kanit dogrulanmaz, bu yuzden yanit
      // yazimi bekler. Basarisiz olursa hata degil `rootPending` doner:
      // taahhut gercekten eklendi, eksik olan yalnizca zincir yazimi.
      const pushed = await queueRootPush(tree.root);

      return json(res, 200, {
        index,
        root: tree.root.toString(),
        rootPending: !pushed,
      });
    }

    // GET /path/:commitment
    if (req.method === "GET" && url.pathname.startsWith("/path/")) {
      const commitment = BigInt(url.pathname.slice("/path/".length));
      const index = tree.indexOf(commitment);
      if (index === -1) return json(res, 404, { error: "taahhut agacta yok" });

      const proof = tree.proof(index);
      return json(res, 200, {
        index,
        siblings: proof.siblings.map(String),
        pathIndices: proof.pathIndices,
        root: tree.root.toString(),
      });
    }

    // POST /ipfs/upload — sifreli blobu Pinata'ya vekaleten yukler.
    // JWT burada kalir; istemciye hicbir zaman inmez.
    if (req.method === "POST" && url.pathname === "/ipfs/upload") {
      return handleUpload(req, res, json);
    }

    return json(res, 404, { error: "bulunamadi" });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Kurator http://localhost:${PORT} uzerinde dinliyor`);
});
