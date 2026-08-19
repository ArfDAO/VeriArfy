/**
 * Metrik paneli, zaman serisi indirgemesi ve olcekleme — veri kategorisi 2.
 *
 * # Neden bu dosya var
 *
 * `panel.ts` genomik tarafta sunu cozuyordu: zincir yalnizca sirali sayilar
 * gorur, hangi varyanta karsilik geldikleri yazili degildir. Surekli olcumde
 * AYNI hata iki kat daha kolay olur, cunku bir de BIRIM vardir:
 *
 *   - indeks 3 Alice icin VO2 max, Bob icin laktat esigi olabilir,
 *   - ikisi de VO2 max gonderse bile biri ml/kg/dk digeri L/dk olabilir.
 *
 * Cozum aynidir: calisma sirali bir METRIK PANELI ilan eder ve her metrigin
 * olcegi, birimi ve gecerli araligi ZINCIRDE durur. Bu dosya kullanicinin
 * olcumlerini o panele hizalar.
 *
 * # Zaman serisi neden burada indirgeniyor
 *
 * Giyilebilir bir cihaz 1 Hz'de gunde 86.400 ornek uretir. Her ornegi
 * sifreleyip zincire yazmak islem basina 8 ornek hizinda gunde ~10.800 islem
 * demektir — imkansiz. Ama daha onemlisi GEREKSIZ: bilim zaten turetilmis
 * metriklerle calisir. VO2 max ham nefes verisi degil bir rampa testinin
 * sonucudur; laktat esigi bir egriden okunur; kreatin kinaz onarim hizi iki
 * olcum arasindaki egimdir.
 *
 * Bu yuzden indirgeme ISTEMCIDE yapilir ve zincire donemsel metrik girer.
 * Ham seri kullanicinin cihazinda kalir — mahremiyet acisindan da dogrusu bu.
 *
 * DURUST SINIR: indirgemenin dogru yapildigi zincirde KANITLANMAZ.
 * Sozlesmenin zorladigi tek sey araliktir; tipki beyan edilen herhangi bir
 * olcum gibi. Kanitli indirgeme ZK gerektirir ve kapsam disidir.
 */

/** Eksik olcum isareti — kontrattaki `BIOMARKER_MISSING` ile AYNI olmalidir. */
export const BIOMARKER_MISSING = 0;

/** Kodlanmis degerin ust siniri — kontrattaki `MAX_METRIC_VALUE`. */
export const MAX_METRIC_VALUE = 1_048_575;

/** Tek bir metrigin tanimi; zincirdeki `MetricSpec` ile birebir. */
export interface MetricSpec {
  /** Metrik kimligi (ornegin LOINC kodu). */
  code: string;
  /** Birim etiketi, ornegin `"ml/kg/min"`. */
  unit: string;
  /** Olcek: `kodlanmis = gercek * scale + offset`. */
  scale: number;
  /** Sifir noktasi; yalnizca isaretli buyukluklerde sifirdan farklidir. */
  offset: number;
  /** Gecerli kodlanmis alt sinir (dahil). En az 1. */
  minValue: number;
  /** Gecerli kodlanmis ust sinir (dahil). */
  maxValue: number;
}

export interface MetricPanel {
  panelId: string;
  version: number;
  metrics: MetricSpec[];
}

/**
 * Metrik tanim belgesinin kanonik ozeti — zincirdeki `metricsHash`.
 *
 * Sayisal sinirlar zaten zincirde durdugu icin bu ozet SINIRLARIN degil
 * TANIMIN kanitidir. Iki calisma ayni araligi ilan edip farkli protokolle
 * olcerse (ornegin VO2 max'i rampa testiyle mi yoksa tahmin denklemiyle mi)
 * sayilar karsilastirilamaz; ozet bu farki gorunur kilar.
 */
export async function metricsDigest(panel: MetricPanel): Promise<string> {
  const canonical = [
    panel.panelId,
    String(panel.version),
    ...panel.metrics.map(
      (m) => `${m.code}|${m.unit}|${m.scale}|${m.offset}|${m.minValue}|${m.maxValue}`,
    ),
  ].join("\n");

  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return (
    "0x" +
    Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Gercek degeri zincirin bekledigi tamsayiya cevirir.
 *
 * @returns Kodlanmis deger — ya da aralik disindaysa `null`.
 *
 * @remarks Aralik disi deger sinira KIRPILMAZ. Kirpma, uydurma ama gecerli
 *          gorunen bir gozlem uretirdi: 200 ml/kg/dk gonderen bir olcum 90'a
 *          kirpilsaydi "olaganustu sporcu" olarak ortalamayi yukari cekerdi.
 *          `null` donen olcum `BIOMARKER_MISSING` olarak gonderilir ve o
 *          metrigin sayimina hic girmez.
 */
export function encodeValue(value: number, spec: MetricSpec): number | null {
  if (!Number.isFinite(value)) return null;

  const encoded = Math.round(value * spec.scale + spec.offset);
  if (encoded < spec.minValue || encoded > spec.maxValue) return null;
  return encoded;
}

/** Kodlanmis degeri gercek olcuye cevirir — panelde gostermek icin. */
export function decodeValue(encoded: number, spec: MetricSpec): number {
  return (encoded - spec.offset) / spec.scale;
}

/** Kullanicinin tek bir olcumu. */
export interface Reading {
  /** Panelde tanimli metrik kodu. */
  code: string;
  /** GERCEK deger, metrigin biriminde (olcekli degil). */
  value: number;
}

export interface MetricAlignment {
  /** Panel SIRASINDA kodlanmis degerler; eksikler `BIOMARKER_MISSING`. */
  values: number[];
  /** Gecerli olcum sayisi. */
  covered: number;
  /** Eksik ya da aralik disi kalan metrik sayisi. */
  missing: number;
  /** Kapsama orani (0..1). */
  coverage: number;
  /** Kullanicida olup panelde OLMAYAN olcumler — bilgi amacli. */
  ignored: number;
  /**
   * Aralik disi kaldigi icin elenen metriklerin kodlari.
   *
   * Sessizce yutulmaz: kullaniciya "su olcumun panelin araligina girmiyor"
   * denebilmeli. Aksi halde kapsama orani aciklanamaz sekilde duser.
   */
  outOfRange: string[];
}

/**
 * Kullanicinin olcumlerini panele hizalar.
 *
 * @returns Panel sirasinda kodlanmis dizi. Panelde olup kullanicida olmayan
 *          her metrik `BIOMARKER_MISSING` alir.
 */
export function alignToMetrics(
  panel: MetricPanel,
  readings: Iterable<Reading>,
): MetricAlignment {
  const byCode = new Map<string, number>();
  for (const reading of readings) {
    if (reading.code) byCode.set(reading.code.toUpperCase(), reading.value);
  }

  const values: number[] = [];
  const outOfRange: string[] = [];
  let covered = 0;
  let missing = 0;

  for (const spec of panel.metrics) {
    const raw = byCode.get(spec.code.toUpperCase());
    const encoded = raw === undefined ? null : encodeValue(raw, spec);

    if (encoded === null) {
      values.push(BIOMARKER_MISSING);
      missing += 1;
      if (raw !== undefined) outOfRange.push(spec.code);
    } else {
      values.push(encoded);
      covered += 1;
    }
  }

  const panelCodes = new Set(panel.metrics.map((m) => m.code.toUpperCase()));
  let ignored = 0;
  for (const code of byCode.keys()) {
    if (!panelCodes.has(code)) ignored += 1;
  }

  return {
    values,
    covered,
    missing,
    coverage: panel.metrics.length === 0 ? 0 : covered / panel.metrics.length,
    ignored,
    outOfRange,
  };
}

/* ------------------------------------------------------------------ *
 * Zaman serisi indirgemesi
 * ------------------------------------------------------------------ */

/** Zaman damgali tek bir sensor ornegi. */
export interface Sample {
  /** Unix zaman damgasi, milisaniye. */
  t: number;
  /** Olculen deger, metrigin biriminde. */
  v: number;
}

export interface SeriesSummary {
  n: number;
  mean: number;
  min: number;
  max: number;
  /** Son ornek — "guncel durum" metrikleri icin. */
  last: number;
  /**
   * En kucuk kareler egimi, BIRIM/GUN.
   *
   * Kreatin kinaz onarim hizi gibi metriklerin tanimi budur ve normalde
   * NEGATIFTIR (deger dusuyor demek iyilesme demek). Bu yuzden boyle bir
   * metrik panelde `offset` ile tanimlanmalidir; aksi halde kodlanamaz.
   */
  slopePerDay: number;
}

/**
 * Ham seriyi donemsel metriklere indirger.
 *
 * @param samples Zaman damgali ornekler; sirali olmasi GEREKMEZ.
 *
 * @remarks Egim en kucuk karelerle hesaplanir ve gune normalize edilir.
 *          Zaman farki sifirsa (tum ornekler ayni ana ait) egim 0 doner —
 *          bolme yerine acik bir karar, cunku `NaN` sessizce panele sizardi.
 */
export function summarizeSeries(samples: Iterable<Sample>): SeriesSummary | null {
  const points = [...samples]
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.v))
    .sort((a, b) => a.t - b.t);

  if (points.length === 0) return null;

  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    sum += p.v;
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }

  const n = points.length;
  const mean = sum / n;

  // Zaman ekseni GUN cinsinden ve ilk orneğe gore kaydirilmis: mutlak Unix
  // milisaniyeleriyle en kucuk kareler yapmak kayan noktada duyarlilik
  // kaybettirir (1,7e12 mertebesinde sayilarin karesi).
  const MS_PER_DAY = 86_400_000;
  const t0 = points[0].t;

  let sumT = 0;
  let sumTT = 0;
  let sumTV = 0;
  for (const p of points) {
    const t = (p.t - t0) / MS_PER_DAY;
    sumT += t;
    sumTT += t * t;
    sumTV += t * p.v;
  }

  const denominator = n * sumTT - sumT * sumT;
  const slopePerDay = denominator === 0 ? 0 : (n * sumTV - sumT * sum) / denominator;

  return { n, mean, min, max, last: points[n - 1].v, slopePerDay };
}

/* ------------------------------------------------------------------ *
 * Istatistigin geri cevrimi
 * ------------------------------------------------------------------ */

/** Zincirden cozulen sifreli toplamlar (grup basina). */
export interface EncodedAggregate {
  n: number;
  sum: number;
  sumSq: number;
}

/**
 * Kodlanmis toplamlari GERCEK olcuye cevirir.
 *
 * @remarks t-degeri ve p-degeri icin BU GEREKMEZ.
 *
 *          ortalama(kodlanmis) = ortalama(gercek) * scale + offset
 *          varyans(kodlanmis)  = varyans(gercek) * scale^2   (offset duser)
 *
 *          t = ortalama farki / standart hata oldugundan offset pay ve
 *          paydada yok olur, `scale` sadelesir: t ve p kodlanmis degerlerden
 *          hesaplandiginda gercek degerlerden hesaplananla BIREBIR AYNIDIR.
 *          Cevrim yalnizca raporlanan ORTALAMA ve FARK icin gereklidir.
 */
export function decodeAggregate(
  agg: EncodedAggregate,
  spec: MetricSpec,
): { n: number; mean: number; sd: number } {
  if (agg.n === 0) return { n: 0, mean: NaN, sd: NaN };

  const meanEncoded = agg.sum / agg.n;
  const mean = decodeValue(meanEncoded, spec);

  if (agg.n === 1) return { n: 1, mean, sd: 0 };

  // (n*Q - S^2) / (n*(n-1)) — tamsayi pay, kayan nokta sapmasi minimum.
  const varianceEncoded = Math.max(
    (agg.n * agg.sumSq - agg.sum * agg.sum) / (agg.n * (agg.n - 1)),
    0,
  );

  return { n: agg.n, mean, sd: Math.sqrt(varianceEncoded) / spec.scale };
}
