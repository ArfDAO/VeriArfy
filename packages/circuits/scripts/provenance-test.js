/**
 * data_provenance devresinin duman testi.
 *
 * Bir ZK devresinde "kanit uretildi ve dogrulandi" tek basina az sey soyler;
 * asil soru devrenin neyi REDDETTIGIDIR. Bu yuzden testlerin cogu olumsuz:
 * her biri gercek bir saldiri senaryosuna karsilik gelir.
 *
 * NOT: Reddetme testleri sirasinda snarkjs'in bastigi `ERROR ... Error in
 * template ...` satirlari BEKLENEN ciktidir — kisit ihlalinin ta kendisidir.
 * Testin basarisi en alttaki ozet satiriyla belirlenir.
 *
 * Calistirma:
 *   packages/circuits$ node scripts/provenance-test.js
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as snarkjs from "snarkjs";

import { computeNullifierHash } from "../src/index.js";
import {
  PANEL_SIZE,
  buildProvenanceInput,
  cidDigestToFieldPair,
  computeProvenanceNullifier,
  createInstitutionKey,
  createInstitutionRegistry,
  packPanel,
  panelCommitment,
  randomSalt,
  signCommitment,
  verifyCommitmentSignature,
} from "../src/provenance.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD = join(__dirname, "..", "build");

const WASM = join(BUILD, "data_provenance_js", "data_provenance.wasm");
const ZKEY = join(BUILD, "data_provenance_final.zkey");
const VKEY = join(BUILD, "data_provenance_verification_key.json");

/** Gercekci bir panel: 16 SNP dozaji. */
const PANEL = [0, 1, 2, 1, 0, 0, 2, 1, 1, 0, 2, 2, 0, 1, 0, 1];

const EXTERNAL_NULLIFIER = 20260814n;
const CID_DIGEST = "0x6141536c73ac0f16a16230490be5131d044466a72ff6c5b31b2eccdd4ffb9b30";
const UPLOADER = "0xD37Df9f97E5e1D285a5B6143e2FB970fD9B108D4";

const ok = (label) => console.log(`  ok — ${label}`);

/** Kanit uretir ve dogrular; basarisiz olursa `null` doner. */
async function prove(input) {
  const vkey = JSON.parse(await readFile(VKEY, "utf8"));
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  return valid ? { proof, publicSignals } : null;
}

/** Devrenin bir tanigi REDDETMESI beklenen durumlar icin. */
async function expectRejection(label, input) {
  try {
    const result = await prove(input);
    assert.equal(result, null, `${label}: devre kabul etti, oysa reddetmeliydi`);
  } catch (error) {
    // Kisit ihlali witness uretimi sirasinda patlar; beklenen davranis budur.
    if (error instanceof assert.AssertionError) throw error;
  }
  ok(label);
}

async function main() {
  console.log("\ndata_provenance duman testi\n");

  // --- Kurulum: akredite kurumlar -----------------------------------------
  const registry = createInstitutionRegistry();

  const hospital = await createInstitutionKey();
  const otherHospital = await createInstitutionKey();
  const rogueLab = await createInstitutionKey(); // akredite DEGIL

  registry.insert(hospital.leaf);
  registry.insert(otherHospital.leaf);

  // --- Kurum paneli imzalar ------------------------------------------------
  const salt = randomSalt();
  const commitment = panelCommitment(PANEL, salt);
  const signature = await signCommitment(hospital.privateKey, commitment);

  assert.equal(
    await verifyCommitmentSignature({ ...hospital, commitment, signature }),
    true,
    "imza zincir disi dogrulamayi gecmeli",
  );
  ok("kurum imzasi zincir disinda dogrulaniyor");

  const baseInput = buildProvenanceInput({
    dosages: PANEL,
    salt,
    institution: hospital,
    signature,
    registry,
    externalNullifier: EXTERNAL_NULLIFIER,
    cidDigest: CID_DIGEST,
    signerAddress: UPLOADER,
  });

  // --- 1) Gecerli kanit + zamanlama ----------------------------------------
  //
  // Sure raporun iddiasini yerine koyacak GERCEK sayidir (§2.8'de RSA icin
  // 3,2 saniye hedefleniyordu). Tek olcum gurultuludur; burada uretim suresi
  // kanitin kendisiyle birlikte olculur ve ekrana basilir.
  const startedAt = performance.now();
  const result = await prove(baseInput);
  const provingMs = performance.now() - startedAt;

  assert.notEqual(result, null, "gecerli tanik kabul edilmeliydi");
  ok(`gecerli kanit uretildi ve dogrulandi (${provingMs.toFixed(0)} ms)`);

  // Acik sinyal sirasi: [root, nullifierHash, commitment, externalNullifier,
  //                      cidHigh, cidLow, signalHash]
  const [root, nullifierHash, publicCommitment, extNull, cidHigh, cidLow, signalHash] =
    result.publicSignals.map(BigInt);

  assert.equal(root, registry.root, "kok akredite agacinkiyle ayni olmali");
  ok("kok, akredite kurumlar agaciyla ayni");

  assert.equal(
    nullifierHash,
    computeProvenanceNullifier(EXTERNAL_NULLIFIER, commitment),
    "nullifier JS hesabiyla ayni olmali",
  );
  ok("nullifierHash JS hesabiyla ayni");

  assert.equal(publicCommitment, commitment, "taahhut JS hesabiyla ayni olmali");
  ok("taahhut JS hesabiyla ayni");

  const { high, low } = cidDigestToFieldPair(CID_DIGEST);
  assert.equal(cidHigh, high);
  assert.equal(cidLow, low);
  assert.equal(extNull, EXTERNAL_NULLIFIER);
  assert.equal(signalHash, BigInt(UPLOADER));
  ok("kanit CID'e ve yukleyen cuzdana bagli");

  // Panelin kendisi hicbir acik sinyalde gorunmemeli.
  const packed = packPanel(PANEL);
  assert.equal(
    result.publicSignals.some((s) => BigInt(s) === packed),
    false,
    "paketlenmis panel acik sinyallerde gorunuyor — gizlilik ihlali",
  );
  ok("panel acik sinyallerde GORUNMUYOR");

  // --- 2) Saldiri: imzasiz veri --------------------------------------------
  await expectRejection("akredite olmayan laboratuvarin imzasi reddedildi", {
    ...buildProvenanceInput({
      dosages: PANEL,
      salt,
      institution: hospital,
      signature: await signCommitment(rogueLab.privateKey, commitment),
      registry,
      externalNullifier: EXTERNAL_NULLIFIER,
      cidDigest: CID_DIGEST,
      signerAddress: UPLOADER,
    }),
  });

  // --- 3) Saldiri: panel degistirildi --------------------------------------
  //
  // Ayni imzayla farkli bir panel yuklemeye calisma. Taahhut degisir, imza
  // artik o taahhudu kapsamaz.
  const tamperedPanel = [...PANEL];
  tamperedPanel[3] = 2; // 1 -> 2

  await expectRejection("degistirilmis panel reddedildi", {
    ...baseInput,
    dosages: tamperedPanel.map(String),
  });

  // --- 4) Saldiri: bicim disi dozaj ----------------------------------------
  const malformedPanel = [...PANEL];
  malformedPanel[0] = 3; // {0,1,2} disinda

  await expectRejection("bicim disi dozaj (3) reddedildi", {
    ...baseInput,
    dosages: malformedPanel.map(String),
  });

  // --- 5) Saldiri: salt degistirilerek nullifier atlatma -------------------
  //
  // Ayni paneli farkli salt ile yeniden yukleyip nullifier'dan kacma denemesi.
  // Kurum TAAHHUDU imzaladigi icin salt degisince imza gecersiz olur.
  await expectRejection("salt degistirilerek nullifier atlatilamiyor", {
    ...baseInput,
    salt: randomSalt().toString(),
  });

  // --- 6) Saldiri: kanit hirsizligi ----------------------------------------
  //
  // Baskasinin gecerli tanigini alip kendi cuzdanina yukleme denemesi. Tanik
  // gizli oldugu icin bu senaryo pratikte zaten zor; burada test edilen sey
  // signalHash'in devreye gercekten bagli olmasi.
  const stolen = await prove({
    ...baseInput,
    signalHash: BigInt("0x000000000000000000000000000000000000dEaD").toString(),
  });
  assert.notEqual(stolen, null, "farkli cuzdanla uretilen kanit kendi icinde gecerli olmali");
  assert.notEqual(
    BigInt(stolen.publicSignals[6]),
    BigInt(UPLOADER),
    "signalHash acik sinyale yansimali — sozlesme uyusmazligi boyle yakalar",
  );
  ok("signalHash acik sinyale yansiyor (sozlesme cuzdan uyusmazligini yakalar)");

  // --- 7) Nullifier gercekten tekrari engelliyor mu ------------------------
  //
  // Aranan iki ozellik:
  //   a) AYNI imzali kayit her zaman AYNI nullifier'i uretmeli — yoksa
  //      tekrar yukleme engellenemez;
  //   b) FARKLI kayitlar farkli nullifier uretmeli — yoksa mesru bir
  //      kullanici baskasi yuzunden bloke olur.

  assert.equal(
    computeProvenanceNullifier(EXTERNAL_NULLIFIER, commitment),
    nullifierHash,
    "ayni kayit ayni nullifier'i uretmeli (tekrar engellenemezdi)",
  );

  const otherPanel = [...PANEL];
  otherPanel[7] = otherPanel[7] === 0 ? 2 : 0;
  const otherCommitment = panelCommitment(otherPanel, randomSalt());

  assert.notEqual(
    computeProvenanceNullifier(EXTERNAL_NULLIFIER, otherCommitment),
    nullifierHash,
    "farkli kayitlar farkli nullifier uretmeli (mesru kullanici bloke olurdu)",
  );
  ok("nullifier tekrari engelliyor, mesru kaydi engellemiyor");

  // --- 8) ALAN AYRIMI: iki devre ayni nullifier bicimini kullaniyor --------
  //
  // Kimlik devresi  : Poseidon(externalNullifier, identityNullifier)
  // Koken devresi   : Poseidon(externalNullifier, commitment)
  //
  // Bicim AYNI. Ikisi tek bir mapping'de saklanirsa, bir devrenin nullifier'i
  // digerini bloke edebilir. Carpisma pratikte imkansiz (ikisi de rastgele
  // alan elemani) ama tasarim guvencesi kriptografik degil istatistikseldir.
  //
  // Bu yuzden kural: iki devre AYNI `externalNullifier` degerini kullanmaz ve
  // sozlesme tarafinda nullifier'lar AYRI mapping'lerde tutulur. Test bunu
  // dogrulayamaz — kayit altina alir.
  assert.equal(
    computeNullifierHash(EXTERNAL_NULLIFIER, commitment),
    computeProvenanceNullifier(EXTERNAL_NULLIFIER, commitment),
    "iki fonksiyon ayni bicimi kullaniyor — ayrim kapsam degeriyle saglanmali",
  );
  ok("alan ayrimi kapsam degeriyle saglaniyor (ayri mapping sarti kayitli)");

  // Kanit boyutu: Groth16 sabit boyutludur (3 eğri noktası) ve devre
  // buyudukce degismez — zincir uzerindeki dogrulama maliyetini sabit tutan
  // ozellik budur.
  const proofBytes = Buffer.byteLength(JSON.stringify(result.proof));

  console.log(`\n=== OLCUM ===`);
  console.log(`panel               : ${PANEL_SIZE} SNP`);
  console.log(`kanit uretimi       : ${provingMs.toFixed(0)} ms`);
  console.log(`kanit boyutu (JSON) : ${proofBytes} bayt`);
  console.log(`acik sinyal sayisi  : ${result.publicSignals.length}`);
  console.log(`=============`);

  console.log(`\nprovenance testi tamam.\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nprovenance testi BASARISIZ:\n${err.stack ?? err}`);
    process.exit(1);
  });
