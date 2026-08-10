/**
 * Devrenin uctan uca calistigini dogrular:
 * kimlik uret -> agaca ekle -> kanit uret -> dogrula.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as snarkjs from "snarkjs";

import { IdentityTree, buildCircuitInput, computeNullifierHash, createIdentity } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD = join(__dirname, "..", "build");

const WASM = join(BUILD, "researcher_identity_js", "researcher_identity.wasm");
const ZKEY = join(BUILD, "researcher_identity_final.zkey");
const VKEY = join(BUILD, "verification_key.json");

const EXTERNAL_NULLIFIER = 1n;
const SIGNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`BASARISIZ: ${message}`);
  }
  console.log(`  ok — ${message}`);
}

async function main() {
  if (!existsSync(ZKEY) || !existsSync(WASM)) {
    console.error("build ciktilari yok. once `npm run build --workspace packages/circuits` calistirin.");
    process.exit(1);
  }

  const tree = new IdentityTree();

  // Birkac baska arastirmaci ekleyerek agaci gercekci hale getir.
  for (let i = 0; i < 3; i++) {
    tree.insert(createIdentity().commitment);
  }

  const identity = createIdentity();
  tree.insert(identity.commitment);
  tree.insert(createIdentity().commitment);

  const input = buildCircuitInput({
    identity,
    tree,
    externalNullifier: EXTERNAL_NULLIFIER,
    signerAddress: SIGNER,
  });

  console.log("kanit uretiliyor...");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);

  const vkey = JSON.parse(await readFile(VKEY, "utf8"));
  const verified = await snarkjs.groth16.verify(vkey, publicSignals, proof);

  console.log("\nsonuclar:");
  assert(verified, "kanit dogrulandi");

  // publicSignals sirasi: [root, nullifierHash, externalNullifier, signalHash]
  assert(BigInt(publicSignals[0]) === tree.root, "root JS agaci ile ayni");
  assert(
    BigInt(publicSignals[1]) === computeNullifierHash(EXTERNAL_NULLIFIER, identity.nullifier),
    "nullifierHash JS hesabi ile ayni",
  );
  assert(BigInt(publicSignals[2]) === EXTERNAL_NULLIFIER, "externalNullifier korunuyor");
  assert(BigInt(publicSignals[3]) === BigInt(SIGNER), "signalHash cuzdana bagli");

  // Bozuk public signal ile dogrulama basarisiz olmali.
  const tampered = [...publicSignals];
  tampered[3] = BigInt("0x0000000000000000000000000000000000000001").toString();
  const tamperedOk = await snarkjs.groth16.verify(vkey, tampered, proof);
  assert(!tamperedOk, "farkli cuzdan icin kanit reddedildi");

  console.log("\nsmoke test tamam.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
