/** Anket yanitlarindan puan hesabi. */
import {
  ANXIETY_ITEMS,
  ANXIETY_MAX,
  PANIC_ITEMS,
  PANIC_MAX,
  SUBSCALES,
  anxietyBand,
} from "./instruments.js";

function checkResponses(responses, items, maxPerItem, name) {
  if (!Array.isArray(responses) || responses.length !== items.length) {
    throw new Error(`${name}: ${items.length} yanit bekleniyor, ${responses?.length} geldi.`);
  }
  for (const r of responses) {
    if (!Number.isInteger(r) || r < 0 || r > maxPerItem) {
      throw new Error(`${name}: her yanit 0–${maxPerItem} arasi tamsayi olmali (gelen: ${r}).`);
    }
  }
}

/** 33 maddelik anksiyete yanitlarini puanlar. */
export function scoreAnxiety(responses) {
  checkResponses(responses, ANXIETY_ITEMS, 3, "Anksiyete");

  const subtotals = {
    [SUBSCALES.FEELINGS]: 0,
    [SUBSCALES.THOUGHTS]: 0,
    [SUBSCALES.PHYSICAL]: 0,
  };

  let total = 0;
  ANXIETY_ITEMS.forEach((item, i) => {
    total += responses[i];
    subtotals[item.sub] += responses[i];
  });

  return { total, max: ANXIETY_MAX, band: anxietyBand(total), subtotals };
}

/** 7 maddelik panik yanitlarini puanlar. */
export function scorePanic(responses) {
  checkResponses(responses, PANIC_ITEMS, 4, "Panik");
  const total = responses.reduce((a, b) => a + b, 0);
  return { total, max: PANIC_MAX };
}

/** Bir katilimcinin tam gonderimini puanlar. */
export function scoreSubmission({ group, anxietyResponses, panicResponses }) {
  if (!Number.isInteger(group) || group < 0 || group > 2) {
    throw new Error(`Gecersiz kullanim grubu: ${group}`);
  }
  const anxiety = scoreAnxiety(anxietyResponses);
  const panic = scorePanic(panicResponses);
  return { group, anxiety: anxiety.total, panic: panic.total, detail: { anxiety, panic } };
}
