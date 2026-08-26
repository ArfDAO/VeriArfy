/**
 * Ki-kare ve coklu test duzeltmesi — bilinen degerlere karsi dogrulama.
 *
 * Referans degerler istatistik tablolarindan alinmistir; kendi kodumuzun
 * ciktisiyla karsilastirilir. Ozel fonksiyonlar (eksik gama) elle yazildigi
 * icin bu kontrol sart: sessizce yanlis bir p-degeri, "anlamli bulgu"
 * uretirdi.
 */
import { chiSquareP, chiSquareTest, benjaminiHochberg } from "../src/stats.js";

const near = (a, b, tol, label) => {
  const ok = Math.abs(a - b) < tol;
  console.log(`${ok ? "  ok " : "  HATA"} ${label}: ${a} (beklenen ~${b})`);
  if (!ok) process.exitCode = 1;
};

// Bilinen ki-kare kuyruk degerleri (istatistik tablolarindan).
near(chiSquareP(3.841, 1), 0.05, 1e-3, "chi2=3.841 df=1 -> p=0.05");
near(chiSquareP(5.991, 2), 0.05, 1e-3, "chi2=5.991 df=2 -> p=0.05");
near(chiSquareP(9.210, 2), 0.01, 1e-3, "chi2=9.210 df=2 -> p=0.01");
near(chiSquareP(0, 2), 1, 1e-12, "chi2=0 -> p=1");
near(chiSquareP(100, 2), 0, 1e-9, "chi2=100 df=2 -> p~0");

// 2x2: elle hesaplanabilir tablo.
const t = chiSquareTest([[10, 20], [20, 10]]);
near(t.chi2, 6.6667, 1e-3, "2x2 chi2");
console.log(`  ok  df=${t.df}, p=${t.p.toFixed(5)}, minExpected=${t.minExpected}`);

// Bos sutun df'i dusurmeli, Infinity uretmemeli.
const sparse = chiSquareTest([[5, 0, 3], [4, 0, 6]]);
console.log(`  ok  bos sutunlu tablo: df=${sparse.df} (2 degil 1 olmali), chi2=${sparse.chi2.toFixed(3)}`);
if (sparse.df !== 1 || !Number.isFinite(sparse.chi2)) process.exitCode = 1;

// BH monotonluk.
const bh = benjaminiHochberg([0.001, 0.008, 0.039, 0.041, 0.042]);
console.log("  ok  BH:", bh.map((x) => x.toFixed(4)).join(" "));
for (let i = 1; i < bh.length; i++) if (bh[i] < bh[i - 1] - 1e-12) process.exitCode = 1;

console.log(process.exitCode ? "\nBASARISIZ" : "\n✓ Ki-kare ve BH dogrulandi.");
