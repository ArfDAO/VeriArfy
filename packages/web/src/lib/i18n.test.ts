/**
 * Sozlugun BUTUNLUGU.
 *
 * Ceviri hatalari sessizdir: yanlis bir yer tutucu ekranda `{n}` olarak
 * kalir, eksik bir anahtar Turkce basilir. Ikisi de uygulamayi dusurmez,
 * bu yuzden derleyici degil test yakalamali.
 */
import { describe, expect, it } from "vitest";

import { EN } from "./locales/en";

/** `{ad}` bicimindeki yer tutucularin kumesi. */
function placeholders(text: string): Set<string> {
  return new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
}

describe("Ingilizce sozluk", () => {
  it("her cevirinin yer tutuculari kaynakla AYNI", () => {
    const broken: string[] = [];

    for (const [source, translated] of Object.entries(EN)) {
      const want = placeholders(source);
      const got = placeholders(translated);
      const same = want.size === got.size && [...want].every((k) => got.has(k));
      if (!same) broken.push(`${source} -> ${translated}`);
    }

    // Yer tutucu dusen bir ceviri ekranda ham `{n}` gosterir ya da degeri
    // tamamen yutar; ikisi de sessizdir.
    expect(broken).toEqual([]);
  });

  it("hicbir ceviri bos degil", () => {
    const empty = Object.entries(EN).filter(([, v]) => v.trim() === "");
    expect(empty).toEqual([]);
  });

  it("ceviri kaynagin AYNISI degil (kopyala-yapistir kalintisi)", () => {
    // Bazi metinler dogal olarak ayni kalir (kisaltmalar, formul adlari);
    // beklenen liste acik tutulur ki yeni bir kopyala-yapistir fark edilsin.
    const identicalAllowed = new Set([
      "CHI2", "FHE ✓/✗", "FHE:", "Zama Concrete ML", "WELCH t + COHEN d",
      "KONTROL 0/1/2", "VAKA 0/1/2", "p", "p (FDR)", "t / d", "isEnrolled",
      "submitRecord", "ciphertext handle", "Metrik #{list}", "SNP #{list}",
    ]);

    const suspicious = Object.entries(EN)
      .filter(([k, v]) => k === v && !identicalAllowed.has(k))
      .map(([k]) => k);

    expect(suspicious).toEqual([]);
  });
});
