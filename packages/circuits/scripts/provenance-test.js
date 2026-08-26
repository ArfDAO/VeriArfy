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
  buildSelfProvenanceInput,
  cidDigestToFieldPair,
  computeProvenanceNullifier,
  createInstitutionKey,
  createInstitutionRegistry,
  coverageWords,
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
/**
 * Test paneli, `PANEL_SIZE`'dan TURETILIR — sabit uzunlukta yazilmaz.
 *
 * Onceden 16 elemanlik sabit bir diziydi ve panel buyutuldugunde testler
 * "uzunluk uyusmuyor" ile dustu. Boyut degistiginde testin de degismesi
 * gerekmesi, testi kirilgan yapar; asil dogrulanan sey uzunluk degil
 * davranistir.
 *
 * Desen tekrarlanir ama sabit degildir: her uc dozaj degeri de temsil edilir,
 * boylece bicim kontrolu (0/1/2) gercekten sinanir.
 */
/**
 * Test paneli — EKSIK deger (3) DAHIL.
 *
 * Gercek dosyalarda cagirilamamis genotip vardir (test ettigimiz PGP
 * dosyasinda 638.463 satirin 21.987'si). Devre yalnizca {0,1,2} kabul
 * ederken koken kaniti bu dosyalarda hic uretilemiyordu.
 */
const PANEL = Array.from({ length: PANEL_SIZE }, (_, i) => [0, 1, 2, 3, 0, 2][i % 6]);

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

  // Acik sinyal sirasi:
  //   [root, nullifierHash, commitment, coverage[0..W-1],
  //    externalNullifier, cidHigh, cidLow, signalHash, attested]
  //
  // Kapsama kelimeleri ARADA durur cunku circom once ciktileri, sonra acik
  // girdileri yazar. Sabit indeks yazmak kirilgan olurdu — sondan sayilir.
  const signals = result.publicSignals.map(BigInt);
  const [root, nullifierHash, publicCommitment] = signals;
  const [extNull, cidHigh, cidLow, signalHash, attested] = signals.slice(-5);
  const coverage = signals.slice(3, signals.length - 5);

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

  assert.equal(attested, 1n, "kurum imzali katmanda attested = 1 olmali");
  ok("katman ayraci acik sinyalde (attested = 1)");

  // --- KAPSAMA: devrenin turettigi bitler JS hesabiyla ayni mi ------------
  //
  // Odeme bu bitlere gore dagitiliyor. Devre ile istemci ayrisirsa, kanit
  // gecerli gorunur ama yanlis alanlar icin pay olusur.
  const expectedCoverage = coverageWords(PANEL);
  assert.deepEqual(
    coverage.map(String),
    expectedCoverage.map(String),
    "kapsama kelimeleri JS hesabiyla ayni olmali",
  );
  ok(`kapsama bitleri dogru (${coverage.length} kelime)`);

  // Eksik isaretli alan kapsamaya GIRMEMELI.
  const missingIndex = PANEL.findIndex((d) => d === 3);
  if (missingIndex >= 0) {
    const word = coverage[Math.floor(missingIndex / 240)];
    const bit = (word >> BigInt(missingIndex % 240)) & 1n;
    assert.equal(bit, 0n, "eksik alan kapsamada isaretli gorunuyor");
    ok(`eksik alan (indeks ${missingIndex}) kapsamada YOK`);
  }

  // Panelin kendisi hicbir acik sinyalde gorunmemeli.
  // `packPanel` artik PARCA LISTESI dondurur; hicbir parca sizmamali.
  const packedChunks = packPanel(PANEL);
  for (const chunk of packedChunks) {
    assert.equal(
      result.publicSignals.some((s) => BigInt(s) === chunk),
      false,
      "paketlenmis panel parcasi acik sinyallerde gorunuyor — gizlilik ihlali",
    );
  }
  ok(`panel acik sinyallerde GORUNMUYOR (${packedChunks.length} parca)`);

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
  //
  // DIKKAT: 3 artik GECERLIDIR (EKSIK). Bu test onceden 3 kullaniyordu ve
  // dogru sebeple degil, taahhut degistigi icin geciyordu. Bicim kontrolunu
  // gercekten sinamak icin kume disinda bir deger gerekir.
  const malformedPanel = [...PANEL];
  malformedPanel[0] = 4; // {0,1,2,3} disinda

  await expectRejection("bicim disi dozaj (4) reddedildi", {
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
  // Sabit indeks kullanilmaz: sinyal sayisi devre degistikce kayar ve testin
  // yanlis alani okumasi sessiz bir yalanci gecise yol acar (bir donem
  // publicSignals[6] okunuyordu; orada signalHash degil kapsama vardi).
  const stolenSignalHash = BigInt(stolen.publicSignals.at(-2));
  assert.notEqual(
    stolenSignalHash,
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

  // --- 9) KENDI YUKLEDIGIM katmani (attested = 0) --------------------------
  //
  // Bugun kullanilan yol: kullanicinin tuketici dosyasinin kurumsal imzasi
  // YOKTUR. Devre imzayi anahtarla kapatir; ama kapsama bitleri yine
  // taahhutten TURETILIR, yani odeme beyana degil matematige dayanir.
  const selfSalt = randomSalt();
  const selfCommitment = panelCommitment(PANEL, selfSalt);

  const selfInput = buildSelfProvenanceInput({
    dosages: PANEL,
    salt: selfSalt,
    externalNullifier: EXTERNAL_NULLIFIER,
    cidDigest: CID_DIGEST,
    signerAddress: UPLOADER,
  });

  const selfResult = await prove(selfInput);
  assert.notEqual(selfResult, null, "imzasiz katman kanit uretebilmeliydi");

  const selfSignals = selfResult.publicSignals.map(BigInt);
  assert.equal(selfSignals.at(-1), 0n, "attested = 0 olmali");
  ok("imzasiz katman (attested = 0) kanit uretiyor");

  // KATMAN KILIDI — en onemli kontrol.
  //
  // Imzasiz katmanda kok SIFIR olmali. Sifir olmayan bir kok, sozlesmede
  // "akredite" muamelesi gorur; devre bunu uretebilseydi iki katman
  // birbirine karisir ve imzasiz veri imzali gibi odenirdi.
  assert.equal(selfSignals[0], 0n, "imzasiz katmanda kok sifir olmali");
  ok("imzasiz katmanda kok SIFIR — katmanlar karismiyor");

  // Kapsama yine dogru turetiliyor: bu katmanin asil kazanimi budur.
  assert.deepEqual(
    selfSignals.slice(3, selfSignals.length - 5).map(String),
    expectedCoverage.map(String),
    "imzasiz katmanda da kapsama taahhutten turetilmeli",
  );
  ok("imzasiz katmanda kapsama yine uydurulamaz");

  assert.equal(selfSignals[2], selfCommitment, "taahhut JS hesabiyla ayni olmali");
  ok("imzasiz katmanda taahhut JS hesabiyla ayni");

  // --- 10) Saldiri: imzasiz taniga anahtari acmaya calisma -----------------
  //
  // Sifir, Baby Jubjub uzerinde gecerli bir nokta DEGILDIR; anahtari acan
  // saldirgan EdDSA kisitinda takilir. Yani bu tanik "yukseltilemez".
  await expectRejection("imzasiz tanik attested = 1 ile yeniden kullanilamiyor", {
    ...selfInput,
    attested: "1",
  });

  // --- 11) Saldiri: anahtar Boole olmayan bir deger ------------------------
  //
  // `attested = 2` olsaydi imza dogrulamasi (enabled != 1) atlanabilir ama
  // kok 2 x tree.root olarak SIFIR OLMAYAN cikardi — sozlesme onu akredite
  // sanabilirdi. Boole kisiti tam olarak bunu kapatir.
  await expectRejection("attested Boole olmayan degeri reddediyor", {
    ...selfInput,
    attested: "2",
  });

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
