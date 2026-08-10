/**
 * Kurator servisi.
 *
 * Akredite katilimci taahhutlerinin Merkle agacini tutar ve kanit uretmek icin
 * gereken yolu verir. GIZLI ANAHTAR GORMEZ — yalnizca acik taahhudu bilir,
 * yani bir katilimcinin kim oldugunu ya da ne yanitladigini ogrenemez.
 *
 * Uctan uca dogruluk icin agacin koku zincire yazilmali:
 *   npm run push-root --workspace packages/curator
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { IdentityTree } from "@veriarfy/circuits";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const STORE = join(DATA_DIR, "tree.json");

const PORT = Number(process.env.CURATOR_PORT ?? 8787);

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

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
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
      return json(res, 200, { root: tree.root.toString(), size: commitments.length });
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

      return json(res, 200, { index, root: tree.root.toString() });
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

    return json(res, 404, { error: "bulunamadi" });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Kurator http://localhost:${PORT} uzerinde dinliyor`);
});
