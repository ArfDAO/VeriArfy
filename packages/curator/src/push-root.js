/**
 * Akredite listenin kokunu elle zincire yazar (yedek operator araci).
 *
 * Kurator servisi koku normalde kendisi yazar; bu arac yalnizca servis
 * calismiyorken gerekir.
 *
 * Liste ZINCIRDEN okunur (AccreditationLog), diskteki bir dosyadan degil.
 * Eskiden `data/tree.json` okunuyordu; liste zincire tasindiktan sonra o dosya
 * bayat kaldi ve bu arac calistirilsaydi eski listenin kokunu yazip dogrulanmis
 * butun arastirmacilari gecerli kokun disina iterdi.
 *
 * Kullanim:  npm run curator:push-root
 * Anahtar depo kokundeki `.env` dosyasindan okunur (CURATOR_PRIVATE_KEY).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { IdentityTree } from "@veriarfy/circuits";
import { connect } from "./chain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", "..", "..", ".env") });

async function main() {
  const chain = connect();
  if (!chain.canWrite) throw new Error("CURATOR_PRIVATE_KEY tanimli degil.");
  if (!chain.log) throw new Error("AccreditationLog adresi yok; liste okunamaz, kok yazilmadi.");

  const tree = new IdentityTree();
  const commitments = await chain.loadCommitments();
  for (const c of commitments) tree.insert(c);

  console.log(`Zincirdeki dogrulanmis taahhut: ${commitments.length}`);
  console.log(`Zincirdeki kok : ${await chain.registry.currentRoot()}`);
  console.log(`Listenin koku  : ${tree.root}`);

  const ok = await chain.pushRoot(tree.root);
  if (!ok) throw new Error("Kok yazilamadi.");
  console.log("Kok guncel.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
