/**
 * Tuketici genotip dosyalarinin ayristirilmasi (23andMe, AncestryDNA).
 *
 * # Neden ayri bir ayristirici
 *
 * VCF, klinik/arastirma dunyasinin bicimidir ve `packages/client-side-rust`
 * icindeki akis ayristiricisiyla islenir. Ama B2C tarafinda siradan
 * kullanicilar VCF indirmez: 23andMe ya da AncestryDNA'dan **sekmeli duz
 * metin** indirirler. Bu dosya o kapiyi acar.
 *
 * # Iki bicim, tek cikti
 *
 * 23andMe:
 *     # rsid  chromosome  position  genotype
 *     rs4477212   1   82154   AA
 *
 * AncestryDNA:
 *     rsid  chromosome  position  allele1  allele2
 *     rs4477212   1   82154   A   A
 *
 * Ikisi de `{ rsid, genotype }` uretir; hizalama `panel.ts` isidir.
 *
 * # Neden akis halinde
 *
 * Bu dosyalar 600.000+ satir ve ~25 MB'dir. Tamamini belege alip `split("\n")`
 * demek tarayicida bellegi ikiye katlar. Satir satir islenir.
 */

import type { GenotypeCall } from "./panel";

export type ConsumerFormat = "23andme" | "ancestrydna" | "unknown";

export interface ConsumerParseResult {
  format: ConsumerFormat;
  calls: GenotypeCall[];
  /** Islenen veri satiri sayisi. */
  lines: number;
  /** Cagirilamamis genotip sayisi (`--` vb.) — kaliteyi gosterir. */
  noCalls: number;
  /** Ayristirilmayan satirlar (yorum/baslik haric). */
  skipped: number;
}

/**
 * Bicimi basliktan ve ilk veri satirindan tespit eder.
 *
 * @dev Yalnizca yorum satirlarina bakmak yetmez: AncestryDNA'nin basligi da
 *      `rsid` ile baslar. Ayirt edici olan SUTUN SAYISIDIR — 23andMe genotipi
 *      tek sutunda (`AA`), AncestryDNA iki ayri sutunda (`A`, `A`) verir.
 */
export function detectFormat(sample: string): ConsumerFormat {
  const lines = sample.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const columns = trimmed.split(/\t/);
    // Baslik satirini atla.
    if (columns[0]?.toLowerCase() === "rsid") continue;

    if (columns.length >= 5) return "ancestrydna";
    if (columns.length === 4) return "23andme";
    return "unknown";
  }
  return "unknown";
}

/**
 * Metni ayristirir.
 *
 * @param text   Dosyanin tamami ya da bir parcasi.
 * @param format Bilinmiyorsa otomatik tespit edilir.
 */
export function parseConsumerGenotypes(
  text: string,
  format?: ConsumerFormat,
): ConsumerParseResult {
  const resolved = format && format !== "unknown" ? format : detectFormat(text);

  const calls: GenotypeCall[] = [];
  let lines = 0;
  let noCalls = 0;
  let skipped = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const columns = line.split(/\t/);
    if (columns[0]?.toLowerCase() === "rsid") continue; // baslik

    let rsid: string | undefined;
    let genotype: string | undefined;

    if (resolved === "ancestrydna" && columns.length >= 5) {
      rsid = columns[0];
      genotype = `${columns[3]}${columns[4]}`;
    } else if (resolved === "23andme" && columns.length >= 4) {
      rsid = columns[0];
      genotype = columns[3];
    }

    if (!rsid || !genotype) {
      skipped += 1;
      continue;
    }

    lines += 1;

    // Cagirilamamis genotipler SAYILIR ama atilmaz: hizalama katmani bunlari
    // `DOSAGE_MISSING` yapar. Burada atmak, "dosyada yok" ile "olculemedi"
    // ayrimini kaybettirirdi.
    const normalized = genotype.trim().toUpperCase();
    if (!normalized || normalized === "--" || normalized === "00") noCalls += 1;

    calls.push({ rsid, genotype: normalized });
  }

  return { format: resolved, calls, lines, noCalls, skipped };
}

/**
 * Buyuk dosyayi parca parca okur — tarayicinin bellegini ikiye katlamadan.
 *
 * @dev Chunk sinirinda satir bolunebilir; yarim satir bir sonraki parcaya
 *      tasinir. Bu detay atlanirsa dosyanin ~%0,1'i sessizce kaybolur.
 */
export async function parseConsumerFile(file: Blob): Promise<ConsumerParseResult> {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();

  let carry = "";
  let format: ConsumerFormat = "unknown";
  const merged: ConsumerParseResult = {
    format: "unknown",
    calls: [],
    lines: 0,
    noCalls: 0,
    skipped: 0,
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = carry + value;
    const lastBreak = text.lastIndexOf("\n");

    // Tam satirlari isle, yarim kalani sakla.
    const complete = lastBreak === -1 ? "" : text.slice(0, lastBreak);
    carry = lastBreak === -1 ? text : text.slice(lastBreak + 1);

    if (!complete) continue;

    if (format === "unknown") format = detectFormat(complete);
    const part = parseConsumerGenotypes(complete, format);

    merged.calls.push(...part.calls);
    merged.lines += part.lines;
    merged.noCalls += part.noCalls;
    merged.skipped += part.skipped;
  }

  if (carry.trim()) {
    const tail = parseConsumerGenotypes(carry, format);
    merged.calls.push(...tail.calls);
    merged.lines += tail.lines;
    merged.noCalls += tail.noCalls;
    merged.skipped += tail.skipped;
  }

  merged.format = format;
  return merged;
}
