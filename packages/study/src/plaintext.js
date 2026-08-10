/**
 * DUZ-METIN HATTI — klasik yontem.
 *
 * Ham puanlar oldugu gibi goruluyor; toplamlar dogrudan hesaplaniyor.
 * Bu hat, FHE hattinin dogrulugunu olcmek icin referans (ground truth) gorevi gorur.
 */
import { GROUP_COUNT, PRIMARY_CONTRAST } from "./instruments.js";
import { compareGroups } from "./stats.js";

/**
 * Katilimci puanlarindan grup basina (n, Σx, Σx²) toplamlarini uretir.
 * @param {Array<{group:number, anxiety:number, panic:number}>} rows
 */
export function aggregate(rows) {
  const empty = () =>
    Array.from({ length: GROUP_COUNT }, () => ({ n: 0, sum: 0, sumSq: 0 }));

  const anxiety = empty();
  const panic = empty();

  for (const row of rows) {
    const g = row.group;
    anxiety[g].n += 1;
    anxiety[g].sum += row.anxiety;
    anxiety[g].sumSq += row.anxiety * row.anxiety;

    panic[g].n += 1;
    panic[g].sum += row.panic;
    panic[g].sumSq += row.panic * row.panic;
  }

  return { anxiety, panic };
}

/** Toplamlardan calisma sonucunu uretir (her iki hat da bunu kullanir). */
export function analyze(aggregates) {
  const { a, b } = PRIMARY_CONTRAST;
  return {
    anxiety: compareGroups(aggregates.anxiety[a], aggregates.anxiety[b]),
    panic: compareGroups(aggregates.panic[a], aggregates.panic[b]),
    groups: aggregates,
  };
}

/** Ham satirlardan uctan uca duz-metin analizi. */
export function runPlaintextPipeline(rows) {
  const aggregates = aggregate(rows);
  return { aggregates, result: analyze(aggregates) };
}
