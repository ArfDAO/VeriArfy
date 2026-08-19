/**
 * Calisma paneli ve kullanici dosyasinin panele HIZALANMASI.
 *
 * # Neden bu dosya var — sessiz bir bozulmayi onler
 *
 * Zincir yalnizca sirali dozajlar gorur: `[d0, d1, ... dk]`. Bu dizinin hangi
 * varyantlara karsilik geldigi zincirde yazili DEGILDIR.
 *
 * Iki kullanici farkli dosyalar yukleyip farkli varyant siralari uretirse,
 * "3 numarali SNP" biri icin rs1234 digeri icin rs9999 olur ve kontenjans
 * tablosu ALAKASIZ seyleri toplar. Tek kullaniciyla fark edilmez; ikinci
 * gercek kullanicida sessizce bozulur.
 *
 * Cozum: calisma bir PANEL tanimlar (sirali rsID + etki aleli listesi) ve her
 * istemci kendi dosyasini bu panele hizalar. Panelin ozeti zincirde durur;
 * boylece herkesin ayni listeyi kullandigi dogrulanabilir.
 *
 * # Etki aleli (effect allele) neden gerekli
 *
 * Dozaj "kac kopya" demek degil, "ETKI ALELINDEN kac kopya" demektir. Hangi
 * alelin sayildigi bilinmeden 0/1/2 anlamsizdir: aynı kisi, alel secimine
 * gore 0 da 2 de olabilir. Panel bunu acikca belirtir.
 */

/** Panelin tek bir varyanti. */
export interface PanelVariant {
  /** dbSNP kimligi, ornegin `rs4977574`. */
  rsid: string;
  /** Kromozom (`1`..`22`, `X`, `Y`, `MT`). */
  chrom: string;
  /** 1 tabanli konum. */
  pos: number;
  /** Dozajda SAYILAN alel. */
  effect: string;
  /** Diger alel. */
  other: string;
}

export interface StudyPanel {
  panelId: string;
  version: number;
  /** Referans genom surumu — konumlar buna gore anlamlidir. */
  assembly: "GRCh37" | "GRCh38";
  variants: PanelVariant[];
}

/** Eksik veri isareti — kontrattaki `DOSAGE_MISSING` ile AYNI olmalidir. */
export const DOSAGE_MISSING = 3;

/**
 * Panelin kanonik ozeti — zincirdeki `panelHash` ile karsilastirilir.
 *
 * Kanoniklik sart: ayni panel her makinede AYNI ozeti vermeli. Bu yuzden
 * JSON'un kendisi degil, alanlar sabit bir sirayla ve sabit bir ayracla
 * birlestirilerek ozetlenir — JSON anahtar sirasi ya da bosluklar ozeti
 * degistirmemelidir.
 */
export async function panelDigest(panel: StudyPanel): Promise<string> {
  const canonical = [
    panel.panelId,
    String(panel.version),
    panel.assembly,
    ...panel.variants.map(
      (v) => `${v.rsid}|${v.chrom}|${v.pos}|${v.effect}|${v.other}`,
    ),
  ].join("\n");

  const bytes = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest("SHA-256", bytes);

  return (
    "0x" +
    Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/** Kullanicinin dosyasindan cikan tek bir genotip. */
export interface GenotypeCall {
  rsid: string;
  /** Iki harf, ornegin `"AG"`. Cagirilamamissa bos ya da `"--"`. */
  genotype: string;
}

export interface AlignmentResult {
  /** Panel SIRASINDA dozajlar; eksikler `DOSAGE_MISSING`. */
  dosages: number[];
  /** Panelde bulunan varyant sayisi. */
  covered: number;
  /** Kullanicinin dosyasinda olmayan varyant sayisi. */
  missing: number;
  /** Kapsama orani (0..1). */
  coverage: number;
  /** Dosyada olup panelde OLMAYAN varyantlar — bilgi amacli. */
  ignored: number;
}

/**
 * Kullanicinin genotiplerini panele hizalar.
 *
 * @param panel  Calismanin varyant listesi (SIRA onemlidir).
 * @param calls  Kullanicinin dosyasindan cikan genotipler.
 *
 * @returns Panel sirasinda dozaj dizisi. Panelde olup dosyada olmayan her
 *          varyant `DOSAGE_MISSING` alir — 0 DEGIL, cunku 0 "homozigot
 *          referans" demektir ve bu sessiz bir yalan olurdu.
 */
export function alignToPanel(
  panel: StudyPanel,
  calls: Iterable<GenotypeCall>,
): AlignmentResult {
  // rsID -> genotip. Buyuk dosyalarda (600K+ satir) tek gecis yeterli.
  const byRsid = new Map<string, string>();
  for (const call of calls) {
    if (call.rsid) byRsid.set(call.rsid.toLowerCase(), call.genotype);
  }

  const dosages: number[] = [];
  let covered = 0;
  let missing = 0;

  for (const variant of panel.variants) {
    const genotype = byRsid.get(variant.rsid.toLowerCase());
    const dosage = genotype ? dosageOf(genotype, variant.effect) : null;

    if (dosage === null) {
      dosages.push(DOSAGE_MISSING);
      missing += 1;
    } else {
      dosages.push(dosage);
      covered += 1;
    }
  }

  const panelRsids = new Set(panel.variants.map((v) => v.rsid.toLowerCase()));
  let ignored = 0;
  for (const rsid of byRsid.keys()) {
    if (!panelRsids.has(rsid)) ignored += 1;
  }

  return {
    dosages,
    covered,
    missing,
    coverage: panel.variants.length === 0 ? 0 : covered / panel.variants.length,
    ignored,
  };
}

/**
 * Genotipi etki aleli sayisina cevirir.
 *
 * @returns 0, 1, 2 — ya da cagirilamamis/anlasilmaz ise `null`.
 *
 * @dev Cagirilamamis genotipler (`--`, `00`, `NN`, bos) ve beklenmedik
 *      uzunluktakiler `null` doner; cagiran bunu `DOSAGE_MISSING` yapar.
 *      Sessizce 0 yazmak alel frekanslarini sistematik olarak bozardi.
 */
export function dosageOf(genotype: string, effect: string): number | null {
  const cleaned = genotype.trim().toUpperCase();
  if (!cleaned || cleaned.length !== 2) return null;
  if (cleaned === "--" || cleaned === "00" || cleaned === "NN") return null;

  const target = effect.trim().toUpperCase();
  let count = 0;

  for (const allele of cleaned) {
    if (allele === "-" || allele === "0" || allele === "N") return null;
    if (allele === target) count += 1;
  }
  return count;
}
