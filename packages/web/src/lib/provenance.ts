/**
 * VeriArfy — tarayicida ZK koken kaniti (KENDI YUKLEDIGIM katmani).
 *
 * ## Bu dosya ne yapiyor
 *
 * Kullanicinin panele hizalanmis dozaj vektorunu alir, taahhut eder, kapsama
 * bitlerini turetir ve `data_provenance` devresiyle Groth16 kaniti uretir.
 * Kanit `submitRecord`'a gider; sozlesme kapsamayi ORADAN yazar.
 *
 * ## Neden onemli — odeme
 *
 * Odeme, arastirmacinin istedigi alanlarda GERCEKTEN verisi olanlara
 * dagitilir. Bu bilgi (kapsama bitmap'i) duz metindir; sifreli degerden
 * cikarilamaz. Istemci onu serbestce beyan edebilseydi, "bende bu alan var"
 * deyip bos gondermek veri vermeden pay almak demek olurdu.
 *
 * Kanit bunu kapatir: bitler devrenin ACIK CIKTISIDIR ve taahhude giren
 * dozajlardan turetilir. Uydurmak icin taahhudu degistirmek gerekir, o da
 * kaniti bozar.
 *
 * ## Ne KAPATMAZ — durustce
 *
 * Kurum imzasi olmadigi icin devre "bu dozajlar gercek bir olcumden geliyor"
 * DEMEZ. Uydurma bir dosya yukleyip onun uzerinden kanit uretmek hala
 * mumkundur; bunu ancak imzalayan akredite bir kurum kapatabilir, ZK
 * kapatamaz. Ayrinti: docs/mimari/0017-kanitli-kapsama.md
 */
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon9 } from "poseidon-lite/poseidon9";

/** Devrenin derlendigi panel boyutu — `DataProvenance(1000, 20)`. */
export const PANEL_SIZE = 1000;

/** Merkle agac derinligi — devredeki `LEVELS`. */
export const TREE_DEPTH = 20;

/** Eksik veri isareti. Sozlesmedeki `DOSAGE_MISSING` ile AYNI. */
export const DOSAGE_MISSING = 3;

/** Bir alan elemanina sigan kapsama biti — devredekiyle AYNI. */
export const COVERAGE_BITS_PER_WORD = 240;

/** Bir alan elemanina sigan dozaj (taban 4) — devredekiyle AYNI. */
export const DOSAGES_PER_CHUNK = 125;

/**
 * Devrenin paneli 1000 alanla sabittir: sekiz 125-dozaj parcasi ve salt,
 * yani kesin olarak Poseidon-9 gerekir. Diger ariteleri ithal etmek, bu
 * tek akista hic kullanilmayan buyuk sabit tablolarini tarayiciya tasirdi.
 */

/** BN254 scalar field; `zk.ts` ile ayni devre parametresi. */
const SNARK_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Calisma panelini devrenin boyutuna kadar EKSIK ile doldurur.
 *
 * @remarks Devre sabit 1000 alanla derlenmistir; calisma 10 varyantlik
 *          olabilir. Dolgu `DOSAGE_MISSING` olmali: 0 yazmak "homozigot
 *          referans" demek olurdu ve o alanlar kapsamada VAR gorunurdu.
 *
 *          Sozlesme zaten yalnizca `snpCount` kadar bit okur, ama dolgunun
 *          dogru olmasi devrenin ve istemcinin ayni taahhudu uretmesi icin
 *          sarttir.
 */
export function padPanel(dosages: number[]): number[] {
  if (dosages.length > PANEL_SIZE) {
    throw new Error(`panel en fazla ${PANEL_SIZE} alan olabilir (${dosages.length} verildi)`);
  }
  return [
    ...dosages,
    ...Array.from({ length: PANEL_SIZE - dosages.length }, () => DOSAGE_MISSING),
  ];
}

/**
 * Dozajlari PARCALARA bolerek taban 4 ile paketler.
 *
 * Devredeki dongunun aynisi ve oyle KALMALIDIR: ayrisirsa taahhutler tutmaz
 * ve kanit uretimi anlasilmaz bir hatayla duser.
 */
export function packPanel(dosages: number[]): bigint[] {
  if (dosages.length !== PANEL_SIZE) {
    throw new Error(`panel ${PANEL_SIZE} elemanli olmali, ${dosages.length} verildi`);
  }

  const chunks: bigint[] = [];

  for (let start = 0; start < dosages.length; start += DOSAGES_PER_CHUNK) {
    const stop = Math.min(start + DOSAGES_PER_CHUNK, dosages.length);

    let packed = 0n;
    let placeValue = 1n;

    for (let i = start; i < stop; i++) {
      const dosage = dosages[i];
      if (dosage !== 0 && dosage !== 1 && dosage !== 2 && dosage !== 3) {
        throw new Error(`gecersiz dozaj (indeks ${i}): ${dosage} — yalnizca 0, 1, 2, 3`);
      }
      packed += BigInt(dosage) * placeValue;
      placeValue *= 4n;
    }

    chunks.push(packed);
  }

  return chunks;
}

/** Panelin taahhudu. Panel bundan geri cikarilamaz (salt bilinmedikce). */
export function panelCommitment(dosages: number[], salt: bigint): bigint {
  const chunks = packPanel(dosages);
  return poseidon9([...chunks, salt]);
}

/**
 * Kapsama kelimeleri: bit i = "o alanda gercek veri var".
 *
 * @remarks Devre bunu KENDI turetir. Burada da hesaplanmasinin sebebi
 *          `submitRecord`'a gecirilecek degerlerin bilinmesi ve uyusmazligin
 *          zincire gitmeden yakalanmasidir.
 */
export function coverageWords(dosages: number[]): bigint[] {
  const words: bigint[] = [];

  for (let start = 0; start < dosages.length; start += COVERAGE_BITS_PER_WORD) {
    const stop = Math.min(start + COVERAGE_BITS_PER_WORD, dosages.length);

    let word = 0n;
    let bitValue = 1n;
    for (let i = start; i < stop; i++) {
      if (dosages[i] !== DOSAGE_MISSING) word += bitValue;
      bitValue *= 2n;
    }
    words.push(word);
  }

  return words;
}

/** Kapsam basina nullifier — devredeki `Poseidon(externalNullifier, commitment)`. */
export function provenanceNullifier(externalNullifier: bigint, commitment: bigint): bigint {
  return poseidon2([externalNullifier, commitment]);
}

/** Panel icin rastgele salt. Olmazsa taahhut kaba kuvvetle aranabilir. */
export function randomSalt(): bigint {
  const buf = new Uint8Array(32);
  for (;;) {
    crypto.getRandomValues(buf);
    let hex = "0x";
    for (const b of buf) hex += b.toString(16).padStart(2, "0");
    const candidate = BigInt(hex);
    if (candidate < SNARK_FIELD) return candidate;
  }
}

/**
 * 32 baytlik digest'i iki 128 bitlik alan elemanina boler.
 *
 * NEDEN: digest 256 bit, BN254 skaler alani 254 bit. Tek elemana sigdirmak
 * ust bitleri sessizce kaybederdi.
 */
export function digestToFieldPair(digest: string): { high: bigint; low: bigint } {
  const hex = digest.replace(/^0x/, "").padStart(64, "0");
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`digest 32 bayt olmali: ${digest}`);
  }
  return {
    high: BigInt(`0x${hex.slice(0, 32)}`),
    low: BigInt(`0x${hex.slice(32)}`),
  };
}

/**
 * Gonderilen sifreli metinlerin ozeti — kanitin bagli olacagi "blob".
 *
 * ## Neden IPFS CID'i degil
 *
 * Devre kaniti bir bloba baglar ki baskasinin kaniti calinip farkli bir veriye
 * ilistirilemesin. Tasarimda bu blob IPFS'e yuklenen sifreli dosyaydi.
 *
 * Ama bu akista IPFS'e yuklenen bir dosya YOK: veri, Zama'nin girdi kanitiyla
 * dogrudan zincire sifreli olarak gidiyor. O yuzden kanit, havuza GERCEKTEN
 * giren sifreli metinlerin (ciphertext handle) ozetine baglanir.
 *
 * Bu, uydurma bir CID yazmaktan DAHA GUCLUDUR: kanit artik "bir yerde duran
 * bir dosyaya" degil, zincire giren tam olarak o sifreli degerlere baglidir.
 * Farkli bir katki icin uretilmis kanit buraya ilistirilemez.
 */
export async function handlesDigest(handles: string[]): Promise<string> {
  const bytes = new Uint8Array(handles.length * 32);

  handles.forEach((handle, index) => {
    const hex = handle.replace(/^0x/, "").padStart(64, "0");
    if (hex.length !== 64) throw new Error(`handle 32 bayt olmali: ${handle}`);
    for (let i = 0; i < 32; i++) {
      bytes[index * 32 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
  });

  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `0x${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export interface ProvenanceProof {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
  commitment: bigint;
  nullifierHash: bigint;
  coverage: bigint[];
  /** Kanit uretim suresi (ms) — arayuz bunu gosterir. */
  provingMs: number;
}

/**
 * KENDI YUKLEDIGIM katmani icin Groth16 kaniti uretir.
 *
 * @param dosages Panele hizalanmis dozajlar (calisma boyutunda; dolgu burada).
 *
 * @remarks Kurum alanlari SIFIR verilir. `attested = 0` iken imza dogrulamasi
 *          kapalidir ama sinyaller yine bir deger almak zorundadir — circom'da
 *          "bos birak" yoktur. Sifir secilmesinin sebebi egri uzerinde gecerli
 *          bir nokta OLMAMASIDIR: bu tanik hicbir kosulda `attested = 1` ile
 *          yeniden kullanilamaz.
 */
export async function proveSelfProvenance(params: {
  dosages: number[];
  salt: bigint;
  externalNullifier: bigint;
  blobDigest: string;
  signerAddress: string;
  wasmUrl?: string;
  zkeyUrl?: string;
}): Promise<ProvenanceProof> {
  const padded = padPanel(params.dosages);
  const commitment = panelCommitment(padded, params.salt);
  const { high, low } = digestToFieldPair(params.blobDigest);
  const zeros = Array.from({ length: TREE_DEPTH }, () => "0");

  const input = {
    dosages: padded.map(String),
    salt: params.salt.toString(),
    institutionAx: "0",
    institutionAy: "0",
    S: "0",
    R8x: "0",
    R8y: "0",
    pathIndices: zeros,
    siblings: zeros,
    externalNullifier: params.externalNullifier.toString(),
    cidHigh: high.toString(),
    cidLow: low.toString(),
    signalHash: BigInt(params.signerAddress).toString(),
    attested: "0",
  };

  // DOGRUDAN import — degisken specifier + `@vite-ignore` DEGIL.
  //
  // Onceki hali `const mod = "snarkjs"; await import(mod)` idi. `@vite-ignore`
  // Vite'a "bu import'u cozumleme" der; tarayici da ciplak `snarkjs`
  // belirtecini cozemez ve tam olarak su hatayi verir:
  //
  //     Failed to resolve module specifier 'snarkjs'
  //
  // Statik yazildiginda Vite paketin `browser` kosulunu (build/browser.esm.js)
  // secer ve dinamik import ayri bir parca olarak kalir — snarkjs buyuk
  // oldugu icin tembel yukleme korunur.
  const snarkjs = await import("snarkjs");

  const startedAt = performance.now();
  const { proof } = await snarkjs.groth16.fullProve(
    input,
    params.wasmUrl ?? "/circuits/data_provenance.wasm",
    params.zkeyUrl ?? "/circuits/data_provenance_final.zkey",
  );
  const provingMs = performance.now() - startedAt;

  return {
    // pi_b'nin ic ciftleri TERS SIRADA verilir — snarkjs'in Solidity
    // calldata bicimi budur. Duz kopyalanirsa kanit sessizce dogrulanmaz.
    a: [proof.pi_a[0], proof.pi_a[1]],
    b: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    c: [proof.pi_c[0], proof.pi_c[1]],
    commitment,
    nullifierHash: provenanceNullifier(params.externalNullifier, commitment),
    coverage: coverageWords(padded),
    provingMs,
  };
}
