/**
 * VeriArfy — Veri Kokeni (ZK-Data Provenance) yardimcilari.
 *
 * `data_provenance.circom` ile BIREBIR ayni semayi kullanir:
 *
 *   packed        = sum(dosages[i] * 4^i)
 *   commitment    = Poseidon(packed, salt)
 *   imza          = EdDSA-Poseidon(kurumAnahtari, commitment)
 *   kurumYapragi  = Poseidon(Ax, Ay)
 *   nullifierHash = Poseidon(externalNullifier, commitment)
 *
 * Semanin iki tarafi ayrisirsa kanit sessizce uretilemez hale gelir; bu yuzden
 * her formul devredeki karsiligiyla ayni sirada yazilmistir.
 */
import { randomBytes } from "node:crypto";

import { buildEddsa } from "circomlibjs";
import {
  poseidon2,
  poseidon3,
  poseidon4,
  poseidon5,
  poseidon6,
  poseidon7,
  poseidon8,
  poseidon9,
  poseidon10,
  poseidon11,
  poseidon12,
  poseidon13,
  poseidon14,
  poseidon15,
  poseidon16,
} from "poseidon-lite";

/**
 * Girdi sayisina gore Poseidon.
 *
 * `poseidon-lite` her arite icin AYRI bir fonksiyon verir (sabitler ariteye
 * gore degisir); tek bir genel fonksiyon yoktur. Taahhut, parca sayisi + salt
 * kadar girdi alir ve bu panel boyutuyla degisir — bu yuzden eslemeye ihtiyac
 * var.
 */
const POSEIDON_BY_ARITY = {
  2: poseidon2,
  3: poseidon3,
  4: poseidon4,
  5: poseidon5,
  6: poseidon6,
  7: poseidon7,
  8: poseidon8,
  9: poseidon9,
  10: poseidon10,
  11: poseidon11,
  12: poseidon12,
  13: poseidon13,
  14: poseidon14,
  15: poseidon15,
  16: poseidon16,
};

import { IdentityTree, SNARK_FIELD, TREE_DEPTH, randomFieldElement } from "./index.js";

/**
 * Devrenin derlendigi panel boyutu (`DataProvenance(16, 20)`).
 *
 * Ayni zamanda Concrete devresinin dogrulanmis panel tavani. Degistirmek
 * yalnizca bu sabiti degil, devredeki `PANEL` degerini de degistirmeyi ve
 * yeniden kurulum (setup) yapmayi gerektirir.
 */
export const PANEL_SIZE = 1000;

/** Gecerli dozaj degerleri: 0 hom-referans, 1 heterozigot, 2 hom-alternatif. */
const VALID_DOSAGES = new Set([0, 1, 2]);

/** circomlibjs asenkron kurulur; tek sefer kurup paylasiyoruz. */
let eddsaPromise = null;
function eddsaInstance() {
  eddsaPromise ??= buildEddsa();
  return eddsaPromise;
}

/**
 * Kurum icin yeni bir EdDSA (Baby Jubjub) anahtar cifti uretir.
 *
 * Gercek dagitimda ozel anahtar kurumun HSM'inde durur ve buraya hic gelmez;
 * bu fonksiyon gelistirme ve test icindir.
 */
export async function createInstitutionKey(privateKey = randomBytes(32)) {
  const eddsa = await eddsaInstance();
  const publicKey = eddsa.prv2pub(privateKey);
  const F = eddsa.F;

  const Ax = F.toObject(publicKey[0]);
  const Ay = F.toObject(publicKey[1]);

  return {
    privateKey,
    Ax,
    Ay,
    /** Akredite kurumlar agacindaki yaprak. */
    leaf: poseidon2([Ax, Ay]),
  };
}

/**
 * Bir alan elemanina sigan dozaj sayisi.
 *
 * Dozaj basina 2 bit; BN254 alani ~254 bit. 125 secildi (127 degil): 250 bit,
 * alanin altinda rahat bir pay birakir. Devredeki `DOSAGES_PER_CHUNK` ile
 * BIREBIR ayni olmalidir.
 */
export const DOSAGES_PER_CHUNK = 125;

/**
 * Poseidon en fazla 16 girdi alir; biri salt'a gider.
 * 15 parca x 125 dozaj = 1875.
 */
export const MAX_PANEL_SIZE = 15 * DOSAGES_PER_CHUNK;

/**
 * Dozaj vektorunu PARCALARA bolerek paketler (taban 4).
 *
 * Devredeki dongunun aynisi ve oyle KALMALIDIR: paketleme burada ve devrede
 * ayrisirsa taahhutler tutmaz ve kanit uretimi anlasilmaz bir hatayla duser.
 *
 * Neden parcali: tek bir alan elemanina yalnizca 125 dozaj sigar. Panel daha
 * buyuk olabilsin diye her parca kendi elemanina paketlenir ve taahhut
 * hepsinin uzerinden alinir.
 *
 * Bicim dogrulamasi burada da yapilir: gecersiz bir deger devrede
 * `secondFactor === 0` kisitini kirar — erken ve okunur bicimde yakalamak
 * daha iyidir.
 *
 * @returns {bigint[]} parca degerleri (her biri bir alan elemani)
 */
export function packPanel(dosages) {
  if (dosages.length !== PANEL_SIZE) {
    throw new Error(`panel ${PANEL_SIZE} elemanli olmali, ${dosages.length} verildi`);
  }
  if (dosages.length > MAX_PANEL_SIZE) {
    throw new Error(
      `panel en fazla ${MAX_PANEL_SIZE} olabilir (15 parca x ${DOSAGES_PER_CHUNK}); ` +
        `daha buyugu icin parcalar uzerinde Poseidon agaci gerekir`,
    );
  }

  const chunks = [];

  for (let start = 0; start < dosages.length; start += DOSAGES_PER_CHUNK) {
    const stop = Math.min(start + DOSAGES_PER_CHUNK, dosages.length);

    let packed = 0n;
    // Her parca KENDI basamak degerinden baslar; devrede de oyle.
    let placeValue = 1n;

    for (let index = start; index < stop; index++) {
      const dosage = dosages[index];
      if (!VALID_DOSAGES.has(dosage)) {
        throw new Error(`gecersiz dozaj (indeks ${index}): ${dosage} — yalnizca 0, 1, 2`);
      }
      packed += BigInt(dosage) * placeValue;
      placeValue *= 4n;
    }

    chunks.push(packed);
  }

  return chunks;
}

/** Panelin taahhudu. Panel bundan geri cikarilamaz (salt bilinmedikce). */
export function panelCommitment(dosages, salt) {
  const chunks = packPanel(dosages);
  // Girdi sayisi parca sayisina gore degisir; devredeki `Poseidon(CHUNKS + 1)`
  // ile ayni.
  const hasher = POSEIDON_BY_ARITY[chunks.length + 1];
  if (!hasher) {
    throw new Error(`Poseidon ${chunks.length + 1} girdi icin tanimli degil`);
  }
  return hasher([...chunks, BigInt(salt)]);
}

/** Panel icin rastgele salt. Kaba kuvvetle panel aramayi engeller. */
export function randomSalt() {
  return randomFieldElement();
}

/**
 * Kurum, panelin TAAHHUDUNU imzalar (panelin kendisini degil).
 *
 * Neden taahhut: kurum boylece salt'i da kapsayan bir sey imzalamis olur.
 * Yalnizca panel imzalansaydi, kullanici salt'i degistirip ayni paneli farkli
 * bir taahhutle yeniden yukleyebilir ve nullifier'i atlatabilirdi.
 */
export async function signCommitment(privateKey, commitment) {
  const eddsa = await eddsaInstance();
  const F = eddsa.F;

  const message = F.e(BigInt(commitment));
  const signature = eddsa.signPoseidon(privateKey, message);

  return {
    R8x: F.toObject(signature.R8[0]),
    R8y: F.toObject(signature.R8[1]),
    S: signature.S,
  };
}

/** Imzayi zincir disinda dogrular (devreye girmeden once hizli kontrol). */
export async function verifyCommitmentSignature({ Ax, Ay, commitment, signature }) {
  const eddsa = await eddsaInstance();
  const F = eddsa.F;

  return eddsa.verifyPoseidon(
    F.e(BigInt(commitment)),
    {
      R8: [F.e(BigInt(signature.R8x)), F.e(BigInt(signature.R8y))],
      S: BigInt(signature.S),
    },
    [F.e(BigInt(Ax)), F.e(BigInt(Ay))],
  );
}

/** Kapsam basina nullifier; devredeki Poseidon(externalNullifier, commitment). */
export function computeProvenanceNullifier(externalNullifier, commitment) {
  return poseidon2([BigInt(externalNullifier), BigInt(commitment)]);
}

/**
 * 32 baytlik CID digest'ini iki alan elemanina boler.
 *
 * NEDEN BOLUNUYOR: digest 256 bit, BN254 skaler alani 254 bit. Tek elemana
 * sigdirmak ust bitleri sessizce kaybederdi; iki 128 bitlik yarim guvenli.
 */
export function cidDigestToFieldPair(digest) {
  const hex = String(digest).replace(/^0x/, "").padStart(64, "0");
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`digest 32 bayt olmali: ${digest}`);
  }

  return {
    high: BigInt(`0x${hex.slice(0, 32)}`),
    low: BigInt(`0x${hex.slice(32)}`),
  };
}

/**
 * Akredite kurumlarin Merkle agaci.
 *
 * Arastirmaci agaciyla ayni yapiyi kullanir; ayri bir sinif yerine ayni
 * uygulamanin kullanilmasi, iki agacin hash duzeninin ayrismasini engeller.
 */
export function createInstitutionRegistry(depth = TREE_DEPTH) {
  return new IdentityTree(depth);
}

/**
 * Devreye verilecek tam tanik girdisini hazirlar.
 *
 * @param dosages           16 elemanli dozaj vektoru (gizli kalir)
 * @param salt              panel salt'i (gizli kalir)
 * @param institution       `createInstitutionKey` ciktisi (ozel anahtar kullanilmaz)
 * @param signature         `signCommitment` ciktisi
 * @param registry          akredite kurumlar agaci
 * @param externalNullifier kapsam ayraci
 * @param cidDigest         yuklenen blobun 32 baytlik CID digest'i
 * @param signerAddress     yukleyenin cuzdan adresi
 */
export function buildProvenanceInput({
  dosages,
  salt,
  institution,
  signature,
  registry,
  externalNullifier,
  cidDigest,
  signerAddress,
}) {
  const leafIndex = registry.indexOf(institution.leaf);
  if (leafIndex === -1) {
    throw new Error("imzalayan kurum akredite listede degil");
  }

  const { siblings, pathIndices } = registry.proof(leafIndex);
  const { high, low } = cidDigestToFieldPair(cidDigest);

  return {
    dosages: dosages.map(String),
    salt: BigInt(salt).toString(),
    institutionAx: institution.Ax.toString(),
    institutionAy: institution.Ay.toString(),
    S: BigInt(signature.S).toString(),
    R8x: BigInt(signature.R8x).toString(),
    R8y: BigInt(signature.R8y).toString(),
    pathIndices: pathIndices.map(String),
    siblings: siblings.map(String),
    externalNullifier: BigInt(externalNullifier).toString(),
    cidHigh: high.toString(),
    cidLow: low.toString(),
    signalHash: BigInt(signerAddress).toString(),
  };
}

// ---------------------------------------------------------------------------
// GELISTIRME yardimcilari
// ---------------------------------------------------------------------------

/**
 * Sabit, herkese acik tohum.
 *
 * ###########################################################################
 * #  Buradan turetilen anahtar GIZLI DEGILDIR ve uretimde KULLANILMAZ.      #
 * #  Gercek dagitimda kurum anahtari HSM'de durur; akredite agaca yalnizca  #
 * #  ACIK anahtar eklenir.                                                  #
 * ###########################################################################
 *
 * Sabit olmasinin sebebi: deploy betigi agaci kurup kokunu kontrata yaziyor,
 * canli kontrol ve uctan uca betik ise ayni kurumun adina imza atiyor. Uc
 * betigin ayni anahtara ulasmasi gerekiyor.
 */
const DEVELOPMENT_SEED = "veriarfy-gelistirme-kurumu-tohumu-0001";

/** Geliştirme kurumunun anahtar cifti. URETIMDE KULLANILMAZ. */
export async function developmentInstitution() {
  const { createHash } = await import("node:crypto");
  // EdDSA ozel anahtari 32 bayt olmali.
  const privateKey = createHash("sha256").update(DEVELOPMENT_SEED).digest();
  return createInstitutionKey(privateKey);
}

/**
 * Icinde yalnizca gelistirme kurumu bulunan akredite agac.
 * Kontratin `accreditedRoot` degeri bu agacin kokudur.
 */
export async function developmentRegistry() {
  const institution = await developmentInstitution();
  const registry = createInstitutionRegistry();
  registry.insert(institution.leaf);
  return { institution, registry };
}

export { SNARK_FIELD };
