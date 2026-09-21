/**
 * Istatistik motoru.
 *
 * TASARIM KARARI — neden "aggregate" (toplam) tabanli?
 * Bir grubun tum istatistigi yalnizca UC TAMSAYIDAN turetilebilir:
 *   n  = katilimci sayisi
 *   S  = Σx    (puanlarin toplami)
 *   Q  = Σx²   (puan karelerinin toplami)
 *
 *   ortalama = S / n
 *   varyans  = (n·Q − S²) / (n·(n−1))        <- tamsayi pay/payda, kararli
 *
 * Bu yuzden FHE hatti bireysel puani HIC ACMADAN yalnizca bu uc toplami
 * homomorfik biriktirir; duz-metin hatti ayni uc tamsayiyi dogrudan hesaplar.
 * Iki hat ayni tamsayilari urettigi icin sonraki tum hesaplar bit-bit aynidir.
 */

/* ------------------------------------------------------------------ *
 * Ozel fonksiyonlar (dis bagimlilik yok)
 * ------------------------------------------------------------------ */

/** log Γ(x) — Lanczos yaklasimi. */
export function gammaln(x) {
  const g = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Duzenlenmis eksik beta fonksiyonu icin surekli kesir (Lentz yontemi). */
function betacf(a, b, x) {
  const MAXIT = 300;
  const EPS = 3e-16;
  const FPMIN = 1e-300;

  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Duzenlenmis eksik beta I_x(a,b). */
export function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student-t dagiliminin kumulatif dagilim fonksiyonu. */
export function studentTCdf(t, df) {
  const x = df / (df + t * t);
  const p = 0.5 * betai(df / 2, 0.5, x);
  return t > 0 ? 1 - p : p;
}

/** Iki yonlu p-degeri. */
export function twoTailedP(t, df) {
  return betai(df / 2, 0.5, df / (df + t * t));
}

/** t dagiliminin ters CDF'i (bisection ile). */
export function studentTQuantile(p, df) {
  let lo = -300;
  let hi = 300;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/* ------------------------------------------------------------------ *
 * Toplamlardan grup istatistigi
 * ------------------------------------------------------------------ */

/**
 * @typedef {{ n: number, sum: number, sumSq: number }} Aggregate
 */

/** Uc tamsayidan grup ozeti uretir. */
export function describe(agg) {
  const n = Number(agg.n);
  const S = Number(agg.sum);
  const Q = Number(agg.sumSq);

  if (n === 0) return { n: 0, mean: NaN, variance: NaN, sd: NaN, sum: 0, sumSq: 0 };
  const mean = S / n;
  if (n === 1) return { n, mean, variance: 0, sd: 0, sum: S, sumSq: Q };

  // (n·Q − S²) / (n·(n−1)) — tamsayi pay, kayan nokta sapmasi minimum.
  const numerator = n * Q - S * S;
  const variance = Math.max(numerator / (n * (n - 1)), 0);
  return { n, mean, variance, sd: Math.sqrt(variance), sum: S, sumSq: Q };
}

/**
 * Welch t-testi + Cohen's d + %95 guven araligi.
 * @param {Aggregate} aggA  karsilastirmanin A grubu
 * @param {Aggregate} aggB  karsilastirmanin B grubu
 */
export function compareGroups(aggA, aggB) {
  const A = describe(aggA);
  const B = describe(aggB);

  if (A.n < 2 || B.n < 2) {
    return {
      a: A,
      b: B,
      meanDiff: B.mean - A.mean,
      t: NaN,
      df: NaN,
      p: NaN,
      cohensD: NaN,
      ci95: [NaN, NaN],
      significant: false,
      note: "Yeterli ornek yok (her grupta en az 2 katilimci gerekir).",
    };
  }

  const vA = A.variance / A.n;
  const vB = B.variance / B.n;
  const se = Math.sqrt(vA + vB);

  const meanDiff = B.mean - A.mean; // pozitif => B grubu daha yuksek
  const t = se === 0 ? 0 : meanDiff / se;

  // Welch–Satterthwaite serbestlik derecesi
  const df =
    se === 0
      ? A.n + B.n - 2
      : (vA + vB) ** 2 / (vA ** 2 / (A.n - 1) + vB ** 2 / (B.n - 1));

  const p = se === 0 ? 1 : twoTailedP(t, df);

  // Cohen's d — havuzlanmis standart sapma
  const pooledVar =
    ((A.n - 1) * A.variance + (B.n - 1) * B.variance) / (A.n + B.n - 2);
  const pooledSd = Math.sqrt(pooledVar);
  const cohensD = pooledSd === 0 ? 0 : meanDiff / pooledSd;

  const tCrit = studentTQuantile(0.975, df);
  const ci95 = [meanDiff - tCrit * se, meanDiff + tCrit * se];

  return {
    a: A,
    b: B,
    meanDiff,
    t,
    df,
    p,
    cohensD,
    ci95,
    significant: p < 0.05,
    note: null,
  };
}

/** Cohen's d buyuklugunun sozel karsiligi. */
export function effectSizeLabel(d) {
  const a = Math.abs(d);
  if (Number.isNaN(a)) return "—";
  if (a < 0.2) return "ihmal edilebilir";
  if (a < 0.5) return "kucuk";
  if (a < 0.8) return "orta";
  return "buyuk";
}

/** p-degerini okunabilir bicime cevirir. */
export function formatP(p) {
  if (Number.isNaN(p)) return "—";
  if (p < 0.0001) return "< 0.0001";
  return p.toFixed(4);
}

/* ------------------------------------------------------------------ *
 * Ki-kare — kategorik veri (veri kategorisi 1: genomik dozaj)
 * ------------------------------------------------------------------ */

/**
 * Duzenlenmis eksik gama fonksiyonu P(a, x) — seri acilimi.
 *
 * @remarks Ki-kare p-degeri icin gerekli. Beta fonksiyonu (t-testi) burada
 *          ise yaramaz: farkli dagilim, farkli ozel fonksiyon.
 */
function gammaSeries(a, x) {
  const ITMAX = 300;
  const EPS = 3e-16;

  if (x <= 0) return 0;

  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 0; n < ITMAX; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - gammaln(a));
}

/** Duzenlenmis eksik gama fonksiyonu Q(a, x) — surekli kesir (Lentz). */
function gammaContinuedFraction(a, x) {
  const ITMAX = 300;
  const EPS = 3e-16;
  const FPMIN = 1e-300;

  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;

  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - gammaln(a)) * h;
}

/**
 * Ki-kare dagiliminin ust kuyruk olasiligi: P(X > chi2), df serbestlik dereceli.
 *
 * @remarks Iki yontem BILINCLI olarak ayrilmistir: seri acilimi kucuk `x`'te,
 *          surekli kesir buyuk `x`'te yakinsar. Tek yontem kullanmak
 *          uclarda sessizce yanlis p-degeri uretirdi.
 */
export function chiSquareP(chi2, df) {
  if (!Number.isFinite(chi2) || !Number.isFinite(df) || df <= 0) return NaN;
  if (chi2 <= 0) return 1;

  const a = df / 2;
  const x = chi2 / 2;

  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x);
}

/**
 * Kontenjans tablosundan ki-kare bagimsizlik testi.
 *
 * @param {number[][]} table `[grup][seviye]` sayimlari (bizde 2x3).
 *
 * @remarks Bos satir/sutunlar DUSURULUR ve serbestlik derecesi buna gore
 *          hesaplanir. Dusurulmezse beklenen deger sifir olur, bolme patlar
 *          ve `Infinity` bir ki-kare degeri gibi gorunerek "cok anlamli"
 *          sonuc uretirdi.
 *
 *          `minExpected` uyarisi: ki-kare yaklasimi beklenen hucre sayisi
 *          5'in altina duserse guvenilmez. Sayi gizlenmez, gosterilir.
 */
export function chiSquareTest(table) {
  const rowSums = table.map((row) => row.reduce((a, b) => a + b, 0));
  const colCount = table[0]?.length ?? 0;
  const colSums = Array.from({ length: colCount }, (_, c) =>
    table.reduce((sum, row) => sum + row[c], 0),
  );
  const total = rowSums.reduce((a, b) => a + b, 0);

  const usedRows = rowSums.filter((s) => s > 0).length;
  const usedCols = colSums.filter((s) => s > 0).length;
  const df = (usedRows - 1) * (usedCols - 1);

  if (total === 0 || df <= 0) {
    return { chi2: NaN, df: 0, p: NaN, total, minExpected: NaN, reliable: false };
  }

  let chi2 = 0;
  let minExpected = Infinity;

  for (let r = 0; r < table.length; r++) {
    for (let c = 0; c < colCount; c++) {
      const expected = (rowSums[r] * colSums[c]) / total;
      if (expected === 0) continue; // bos satir/sutun — df'ten zaten dusuldu
      minExpected = Math.min(minExpected, expected);
      const diff = table[r][c] - expected;
      chi2 += (diff * diff) / expected;
    }
  }

  return {
    chi2,
    df,
    p: chiSquareP(chi2, df),
    total,
    minExpected,
    reliable: minExpected >= 5,
  };
}

/**
 * Coklu test duzeltmesi — Benjamini-Hochberg (FDR).
 *
 * @remarks NEDEN GEREKLI: 1000 SNP tararsan, %5 esikte 50 tanesi TESADUFEN
 *          "anlamli" cikar. GWAS'ta duzeltilmemis p-degeri yayimlanmaz.
 *
 *          Bonferroni (p x m) yerine BH secildi: Bonferroni cok muhafazakar,
 *          binlerce testte gercek sinyali de eler. BH yanlis kesif ORANINI
 *          kontrol eder ve GWAS/omics'te standarttir.
 *
 * @param {number[]} pValues
 * @returns {number[]} Girdiyle AYNI SIRADA duzeltilmis p-degerleri.
 */
function requireGenotypeTable(table) {
  if (!Array.isArray(table) || table.length !== 2 || table.some((row) => !Array.isArray(row) || row.length !== 3)) throw new TypeError("genotip tablosu 2x3 olmali");
  for (const count of table.flat()) if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("genotip sayimlari negatif olmayan tamsayi olmali");
}

/** Bir grubun 0/1/2 dozaj sayimlarindan genotip/allel frekanslari ve MAF. */
export function genotypeFrequencies(counts) {
  if (!Array.isArray(counts) || counts.length !== 3 || counts.some((count) => !Number.isSafeInteger(count) || count < 0)) throw new TypeError("genotip sayimlari uc negatif olmayan tamsayi olmali");
  const n = counts[0] + counts[1] + counts[2];
  if (n === 0) return { n: 0, genotype: [NaN, NaN, NaN], allele: { reference: NaN, alternate: NaN }, maf: NaN };
  const alternate = (counts[1] + 2 * counts[2]) / (2 * n);
  return { n, genotype: counts.map((count) => count / n), allele: { reference: 1 - alternate, alternate }, maf: Math.min(alternate, 1 - alternate) };
}

/** Biallelic diploid HWE ki-kare testi; allel frekansi tahmin edildigi icin df=1. */
export function hardyWeinbergTest(counts) {
  const frequencies = genotypeFrequencies(counts);
  const { n, allele } = frequencies;
  if (n === 0 || allele.alternate === 0 || allele.alternate === 1) return { ...frequencies, expected: [NaN, NaN, NaN], chi2: NaN, df: 0, p: NaN, minExpected: NaN, reliable: false };
  const p = allele.alternate;
  const expected = [n * (1 - p) ** 2, n * 2 * p * (1 - p), n * p ** 2];
  const chi2 = counts.reduce((sum, observed, index) => sum + ((observed - expected[index]) ** 2) / expected[index], 0);
  const minExpected = Math.min(...expected);
  return { ...frequencies, expected, chi2, df: 1, p: chiSquareP(chi2, 1), minExpected, reliable: minExpected >= 5 };
}

/** Allel sayimlarindan case/control OR ve Wald %95 guven araligi. */
export function allelicOddsRatio(table) {
  requireGenotypeTable(table);
  const control = genotypeFrequencies(table[0]);
  const cases = genotypeFrequencies(table[1]);
  const controlAlt = table[0][1] + 2 * table[0][2];
  const controlRef = 2 * control.n - controlAlt;
  const caseAlt = table[1][1] + 2 * table[1][2];
  const caseRef = 2 * cases.n - caseAlt;
  if ([controlAlt, controlRef, caseAlt, caseRef].some((count) => count === 0)) return { oddsRatio: NaN, ci95: [NaN, NaN], standardError: NaN, note: "Sifir allel hucresi nedeniyle Wald odds ratio hesaplanamadi." };
  const oddsRatio = (caseAlt * controlRef) / (caseRef * controlAlt);
  const standardError = Math.sqrt(1 / caseAlt + 1 / caseRef + 1 / controlAlt + 1 / controlRef);
  const logOdds = Math.log(oddsRatio);
  return { oddsRatio, ci95: [Math.exp(logOdds - 1.96 * standardError), Math.exp(logOdds + 1.96 * standardError)], standardError, note: null };
}

/** Fisher-Freeman-Halton iki-tarafli exact p-degeri (2xC, sabit marjinler). */
export function fisherFreemanHaltonTest(table) {
  if (!Array.isArray(table) || table.length !== 2 || table[0].length !== table[1].length || table[0].length < 2) throw new TypeError("Fisher-Freeman-Halton tablosu 2xC olmali");
  for (const count of table.flat()) if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("tablo sayimlari negatif olmayan tamsayi olmali");
  const columns = table[0].map((count, index) => count + table[1][index]);
  const row0 = table[0].reduce((sum, count) => sum + count, 0);
  const row1 = table[1].reduce((sum, count) => sum + count, 0);
  const total = row0 + row1;
  if (total === 0 || columns.some((count) => count === 0)) return { p: NaN, observedProbability: NaN, tables: 0 };
  const constant = gammaln(row0 + 1) + gammaln(row1 + 1) + columns.reduce((sum, count) => sum + gammaln(count + 1), 0) - gammaln(total + 1);
  const logProbability = (firstRow) => constant - firstRow.reduce((sum, value, index) => sum + gammaln(value + 1) + gammaln(columns[index] - value + 1), 0);
  const observed = logProbability(table[0]);
  const firstRow = new Array(columns.length).fill(0);
  let p = 0;
  let tables = 0;
  function enumerate(column, remaining) {
    if (column === columns.length - 1) {
      if (remaining < 0 || remaining > columns[column]) return;
      firstRow[column] = remaining;
      const logP = logProbability(firstRow);
      tables += 1;
      if (logP <= observed + 1e-12) p += Math.exp(logP);
      return;
    }
    const rest = columns.slice(column + 1).reduce((sum, count) => sum + count, 0);
    for (let value = Math.max(0, remaining - rest); value <= Math.min(columns[column], remaining); value++) {
      firstRow[column] = value;
      enumerate(column + 1, remaining - value);
    }
  }
  enumerate(0, row0);
  return { p: Math.min(1, p), observedProbability: Math.exp(observed), tables };
}

/** E/18'in izinli 2x3 aggregate tablosundan tum standart genomik ozetleri uretir. */
export function summarizeGenomicTable(table) {
  requireGenotypeTable(table);
  const chiSquare = chiSquareTest(table);
  return { groups: table.map((counts) => ({ frequencies: genotypeFrequencies(counts), hwe: hardyWeinbergTest(counts) })), association: { chiSquare, fisher: chiSquare.reliable ? null : fisherFreemanHaltonTest(table), oddsRatio: allelicOddsRatio(table) } };
}

export function benjaminiHochberg(pValues) {
  const m = pValues.length;
  if (m === 0) return [];

  const order = pValues
    .map((p, i) => ({ p, i }))
    .filter((x) => Number.isFinite(x.p))
    .sort((a, b) => a.p - b.p);

  const adjusted = new Array(m).fill(NaN);
  let previous = 1;

  // Buyukten kucuge yuru ve monoton azalmayi zorla: BH duzeltmesi sirali
  // olmak zorundadir, aksi halde kucuk bir p buyuk bir p'den daha yuksek
  // duzeltilmis deger alabilir.
  for (let k = order.length - 1; k >= 0; k--) {
    const value = Math.min(previous, (order[k].p * order.length) / (k + 1));
    adjusted[order[k].i] = value;
    previous = value;
  }

  return adjusted;
}
