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
