/**
 * TEST VERISI URETICI — DIKKAT.
 *
 * Buradaki veriler GERCEK KATILIMCI YANITI DEGILDIR ve hicbir bilimsel bulgu
 * olarak sunulamaz. Amaci tek: iki hattin (duz-metin ve FHE) ayni girdiyle
 * ayni sonucu urettigini dogrulamak icin tekrarlanabilir bir veri kumesi vermek.
 *
 * Gercek calisma verisi web arayuzunden, ZK ile dogrulanmis katilimcilardan gelir.
 */
import { ANXIETY_ITEMS, PANIC_ITEMS } from "./instruments.js";

/** mulberry32 — tohumlanabilir, deterministik PRNG. */
export function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Verilen olasilik agirligina gore 0..max arasi bir madde yaniti uretir. */
function itemResponse(next, severity, max) {
  // severity 0..1 -> yanit dagilimini yukari kaydirir
  const r = next();
  const shifted = Math.pow(r, Math.max(0.2, 1.6 - severity * 1.4));
  return Math.min(max, Math.round(shifted * max));
}

/**
 * Deterministik test kohortu uretir.
 * @param {object} opts
 * @param {number} opts.seed
 * @param {number[]} opts.groupSizes  her kullanim grubu icin katilimci sayisi
 * @param {number[]} opts.severity    her grup icin 0..1 belirti egilimi
 */
export function makeCohort({
  seed = 42,
  groupSizes = [60, 50, 45],
  severity = [0.25, 0.45, 0.7],
} = {}) {
  const next = rng(seed);
  const rows = [];

  groupSizes.forEach((size, group) => {
    for (let i = 0; i < size; i++) {
      const anxietyResponses = ANXIETY_ITEMS.map(() =>
        itemResponse(next, severity[group], 3),
      );
      const panicResponses = PANIC_ITEMS.map(() =>
        itemResponse(next, severity[group] * 0.85, 4),
      );
      rows.push({ group, anxietyResponses, panicResponses });
    }
  });

  return rows;
}
