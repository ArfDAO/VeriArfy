/**
 * Istatistik motorunun oz-testi.
 *
 * Elle hesaplanabilen referans degerlere karsi dogrular — p-degeri ve
 * etki buyuklugu yanlissa tum calisma yanlis olur, bu yuzden kritiktir.
 */
import {
  describe as summarize,
  compareGroups,
  betai,
  studentTQuantile,
  twoTailedP,
  aggregate,
  analyze,
  runPlaintextPipeline,
  makeCohort,
  scoreSubmission,
  scoreAnxiety,
  ANXIETY_ITEMS,
  PANIC_ITEMS,
} from "../src/index.js";

let failures = 0;

function check(name, actual, expected, tolerance = 1e-9) {
  const ok =
    typeof expected === "number"
      ? Math.abs(actual - expected) <= tolerance
      : actual === expected;
  if (ok) {
    console.log(`  ok — ${name}`);
  } else {
    failures++;
    console.error(`  BASARISIZ — ${name}: beklenen ${expected}, gelen ${actual}`);
  }
}

console.log("\n1) Toplamlardan ozet (n, Σx, Σx²)");
{
  // [1,2,3,4,5] -> n=5, Σx=15, Σx²=55
  const s = summarize({ n: 5, sum: 15, sumSq: 55 });
  check("ortalama", s.mean, 3);
  check("varyans", s.variance, 2.5);
  check("standart sapma", s.sd, Math.sqrt(2.5), 1e-12);
}

console.log("\n2) Eksik beta fonksiyonu");
{
  check("betai(0.5,0.5,0.5) = 0.5", betai(0.5, 0.5, 0.5), 0.5, 1e-10);
  check("betai(2,3,0) = 0", betai(2, 3, 0), 0);
  check("betai(2,3,1) = 1", betai(2, 3, 1), 1);
}

console.log("\n3) Welch t-testi — elle hesaplanabilir ornek");
{
  // A = [1,2,3,4,5]  -> n=5, Σx=15,  Σx²=55
  // B = [6,7,8,9,10] -> n=5, Σx=40,  Σx²=330
  const cmp = compareGroups({ n: 5, sum: 15, sumSq: 55 }, { n: 5, sum: 40, sumSq: 330 });

  check("A ortalamasi", cmp.a.mean, 3);
  check("B ortalamasi", cmp.b.mean, 8);
  check("ortalama farki", cmp.meanDiff, 5);
  // se = sqrt(2.5/5 + 2.5/5) = 1  ->  t = 5
  check("t degeri", cmp.t, 5, 1e-12);
  // df = (0.5+0.5)^2 / (0.25/4 + 0.25/4) = 8
  check("Welch df", cmp.df, 8, 1e-12);
  // havuzlanmis sd = sqrt(2.5) -> d = 5/sqrt(2.5)
  check("Cohen's d", cmp.cohensD, 5 / Math.sqrt(2.5), 1e-12);
  check("anlamli", cmp.significant, true);
  // t=5, df=8 icin iki yonlu p ~ 0.00105
  const pOk = cmp.p > 0.001 && cmp.p < 0.0011;
  check("p araligi (0.001–0.0011)", pOk, true);
}

console.log("\n4) t dagilimi tutarliligi");
{
  // Kritik deger ile p-degeri birbirini tersine cevirmeli.
  const df = 12;
  const tCrit = studentTQuantile(0.975, df);
  check("t kritik(0.975, df=12) ~ 2.179", tCrit, 2.179, 0.002);
  check("p(tCrit) ~ 0.05", twoTailedP(tCrit, df), 0.05, 1e-9);
}

console.log("\n5) Puanlama sinirlari");
{
  const allZero = scoreAnxiety(ANXIETY_ITEMS.map(() => 0));
  check("tum 0 -> toplam 0", allZero.total, 0);
  check("tum 0 -> minimal bandi", allZero.band, "Minimal ya da anksiyete yok");

  const allMax = scoreAnxiety(ANXIETY_ITEMS.map(() => 3));
  check("tum 3 -> toplam 99", allMax.total, 99);
  check("tum 3 -> asiri bandi", allMax.band, "Asiri anksiyete ya da panik");

  let threw = false;
  try {
    scoreAnxiety([1, 2, 3]);
  } catch {
    threw = true;
  }
  check("eksik yanit reddedilir", threw, true);

  let threwRange = false;
  try {
    scoreAnxiety(ANXIETY_ITEMS.map(() => 4));
  } catch {
    threwRange = true;
  }
  check("aralik disi yanit reddedilir", threwRange, true);
}

console.log("\n6) Toplama hatti — elle sayimla ayni mi");
{
  const rows = [
    { group: 0, anxiety: 10, panic: 2 },
    { group: 0, anxiety: 20, panic: 4 },
    { group: 2, anxiety: 50, panic: 10 },
    { group: 2, anxiety: 60, panic: 12 },
  ];
  const agg = aggregate(rows);
  check("g0 n", agg.anxiety[0].n, 2);
  check("g0 Σx", agg.anxiety[0].sum, 30);
  check("g0 Σx²", agg.anxiety[0].sumSq, 100 + 400);
  check("g2 Σx²", agg.anxiety[2].sumSq, 2500 + 3600);
  check("g1 bos", agg.anxiety[1].n, 0);

  const res = analyze(agg);
  check("fark = 55 - 15", res.anxiety.meanDiff, 40);
}

console.log("\n7) Uctan uca — kohort determinizmi");
{
  const a = makeCohort({ seed: 7, groupSizes: [5, 5, 5] }).map(scoreSubmission);
  const b = makeCohort({ seed: 7, groupSizes: [5, 5, 5] }).map(scoreSubmission);
  check(
    "ayni tohum ayni kohortu uretir",
    JSON.stringify(a) === JSON.stringify(b),
    true,
  );

  const pipeline = runPlaintextPipeline(a);
  const totalN =
    pipeline.aggregates.anxiety.reduce((s, g) => s + g.n, 0);
  check("toplam katilimci", totalN, 15);
  check("madde sayilari", ANXIETY_ITEMS.length + PANIC_ITEMS.length, 40);
}

console.log(
  failures === 0
    ? "\n✓ Istatistik motoru dogrulandi.\n"
    : `\n✗ ${failures} kontrol basarisiz.\n`,
);
process.exit(failures === 0 ? 0 : 1);
