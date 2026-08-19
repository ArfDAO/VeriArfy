import { describe, expect, it } from "vitest";

import {
  DOSAGE_MISSING,
  alignToPanel,
  dosageOf,
  panelDigest,
  type StudyPanel,
} from "./panel";
import { detectFormat, parseConsumerGenotypes } from "./consumerGenotype";

/**
 * Panel hizalamasi — sistemin gercek veriyle bozulmamasinin temeli.
 *
 * Zincir yalnizca sirali dozajlar gorur; hangi varyanta karsilik geldikleri
 * yazili degildir. Iki kullanicinin "3 numarali SNP"si ayni varyant DEGILSE
 * kontenjans tablosu alakasiz seyleri toplar ve bu tek kullaniciyla fark
 * edilmez. Bu dosya tam olarak o hatayi kovalar.
 */

const PANEL: StudyPanel = {
  panelId: "veriarfy-test-v1",
  version: 1,
  assembly: "GRCh38",
  variants: [
    { rsid: "rs1000", chrom: "1", pos: 100, effect: "A", other: "G" },
    { rsid: "rs2000", chrom: "1", pos: 200, effect: "T", other: "C" },
    { rsid: "rs3000", chrom: "2", pos: 300, effect: "G", other: "A" },
  ],
};

describe("dozaj cevrimi", () => {
  it("etki alelinin kopya sayisini verir", () => {
    expect(dosageOf("GG", "A")).toBe(0);
    expect(dosageOf("AG", "A")).toBe(1);
    expect(dosageOf("AA", "A")).toBe(2);
  });

  it("alel sirasi onemsiz", () => {
    expect(dosageOf("GA", "A")).toBe(1);
    expect(dosageOf("AG", "A")).toBe(1);
  });

  it("ETKI ALELI degisince dozaj degisir — bu yuzden panelde yazili olmali", () => {
    // Ayni kisi, ayni genotip: hangi alelin sayildigi bilinmeden 0/1/2
    // anlamsizdir.
    expect(dosageOf("AG", "A")).toBe(1);
    expect(dosageOf("AG", "G")).toBe(1);
    expect(dosageOf("AA", "A")).toBe(2);
    expect(dosageOf("AA", "G")).toBe(0);
  });

  it("cagirilamamis genotip 0 DEGIL, null doner", () => {
    // 0 "homozigot referans" demektir; eksik veriye 0 yazmak sessiz bir
    // yalandir ve alel frekanslarini sistematik olarak asagi ceker.
    expect(dosageOf("--", "A")).toBeNull();
    expect(dosageOf("00", "A")).toBeNull();
    expect(dosageOf("NN", "A")).toBeNull();
    expect(dosageOf("", "A")).toBeNull();
    expect(dosageOf("A-", "A")).toBeNull();
  });

  it("beklenmedik uzunluk reddedilir", () => {
    expect(dosageOf("A", "A")).toBeNull();
    expect(dosageOf("AAA", "A")).toBeNull();
  });
});

describe("panele hizalama", () => {
  it("dozajlar PANEL sirasinda cikar, dosya sirasinda degil", () => {
    // Dosyada ters sirada; hizalama panel sirasini dayatmali.
    const result = alignToPanel(PANEL, [
      { rsid: "rs3000", genotype: "GG" },
      { rsid: "rs1000", genotype: "AG" },
      { rsid: "rs2000", genotype: "CC" },
    ]);

    expect(result.dosages).toEqual([1, 0, 2]);
    expect(result.coverage).toBe(1);
  });

  it("panelde olup dosyada olmayan varyant DOSAGE_MISSING alir", () => {
    const result = alignToPanel(PANEL, [
      { rsid: "rs1000", genotype: "AA" },
      { rsid: "rs3000", genotype: "AA" },
    ]);

    expect(result.dosages).toEqual([2, DOSAGE_MISSING, 0]);
    expect(result.missing).toBe(1);
    expect(result.covered).toBe(2);
  });

  it("cagirilamamis genotip de DOSAGE_MISSING olur", () => {
    const result = alignToPanel(PANEL, [
      { rsid: "rs1000", genotype: "AA" },
      { rsid: "rs2000", genotype: "--" },
      { rsid: "rs3000", genotype: "GG" },
    ]);

    expect(result.dosages).toEqual([2, DOSAGE_MISSING, 2]);
    expect(result.missing).toBe(1);
  });

  it("dosyada olup panelde olmayan varyantlar SESSIZCE ATILMAZ, sayilir", () => {
    const result = alignToPanel(PANEL, [
      { rsid: "rs1000", genotype: "AA" },
      { rsid: "rs2000", genotype: "TT" },
      { rsid: "rs3000", genotype: "GG" },
      { rsid: "rs9999", genotype: "AA" }, // panelde yok
      { rsid: "rs8888", genotype: "CC" }, // panelde yok
    ]);

    expect(result.dosages).toEqual([2, 2, 2]);
    expect(result.ignored).toBe(2);
  });

  it("rsID buyuk/kucuk harf duyarli DEGIL", () => {
    const result = alignToPanel(PANEL, [
      { rsid: "RS1000", genotype: "AA" },
      { rsid: "Rs2000", genotype: "TT" },
      { rsid: "rs3000", genotype: "GG" },
    ]);
    expect(result.dosages).toEqual([2, 2, 2]);
  });

  it("IKI FARKLI kullanici ayni panel indeksinde AYNI varyanti tasir", () => {
    // Bu, tum tasarimin sebebi. Kullanicilarin dosyalari farkli siralarda ve
    // farkli kapsamlarda; yine de indeks 1 her ikisinde de rs2000 olmali.
    const alice = alignToPanel(PANEL, [
      { rsid: "rs2000", genotype: "TT" },
      { rsid: "rs1000", genotype: "AG" },
    ]);
    const bob = alignToPanel(PANEL, [
      { rsid: "rs1000", genotype: "GG" },
      { rsid: "rs3000", genotype: "GA" },
      { rsid: "rs2000", genotype: "TC" },
    ]);

    // Indeks 1 = rs2000 her ikisinde de.
    expect(alice.dosages[1]).toBe(2); // TT -> iki T
    expect(bob.dosages[1]).toBe(1); // TC -> bir T

    // Alice'te rs3000 yok -> eksik; Bob'da var.
    expect(alice.dosages[2]).toBe(DOSAGE_MISSING);
    expect(bob.dosages[2]).toBe(1);
  });

  it("bos panel bolme hatasi vermez", () => {
    const empty: StudyPanel = { ...PANEL, variants: [] };
    const result = alignToPanel(empty, [{ rsid: "rs1", genotype: "AA" }]);
    expect(result.dosages).toEqual([]);
    expect(result.coverage).toBe(0);
  });
});

describe("panel ozeti", () => {
  it("ayni panel ayni ozeti verir", async () => {
    expect(await panelDigest(PANEL)).toBe(await panelDigest(PANEL));
  });

  it("VARYANT SIRASI degisince ozet degisir", async () => {
    // Sira anlam tasir: indeks 0 hangi varyant demek, bu ozetle sabitlenir.
    const reordered: StudyPanel = {
      ...PANEL,
      variants: [PANEL.variants[1], PANEL.variants[0], PANEL.variants[2]],
    };
    expect(await panelDigest(reordered)).not.toBe(await panelDigest(PANEL));
  });

  it("ETKI ALELI degisince ozet degisir", async () => {
    const flipped: StudyPanel = {
      ...PANEL,
      variants: [
        { ...PANEL.variants[0], effect: "G", other: "A" },
        ...PANEL.variants.slice(1),
      ],
    };
    expect(await panelDigest(flipped)).not.toBe(await panelDigest(PANEL));
  });

  it("32 baytlik hex doner", async () => {
    expect(await panelDigest(PANEL)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("tuketici dosyalari", () => {
  const TWENTY_THREE = [
    "# This data file generated by 23andMe",
    "# rsid\tchromosome\tposition\tgenotype",
    "rs1000\t1\t100\tAG",
    "rs2000\t1\t200\tTT",
    "rs3000\t2\t300\t--",
  ].join("\n");

  const ANCESTRY = [
    "#AncestryDNA raw data download",
    "rsid\tchromosome\tposition\tallele1\tallele2",
    "rs1000\t1\t100\tA\tG",
    "rs2000\t1\t200\tT\tT",
    "rs3000\t2\t300\t0\t0",
  ].join("\n");

  it("23andMe bicimi taninir", () => {
    expect(detectFormat(TWENTY_THREE)).toBe("23andme");
  });

  it("AncestryDNA bicimi taninir", () => {
    // Ayirt edici sutun sayisidir: AncestryDNA aleli IKI sutunda verir.
    expect(detectFormat(ANCESTRY)).toBe("ancestrydna");
  });

  it("23andMe ayristirilir ve panele hizalanir", () => {
    const parsed = parseConsumerGenotypes(TWENTY_THREE);
    expect(parsed.lines).toBe(3);
    expect(parsed.noCalls).toBe(1);

    const aligned = alignToPanel(PANEL, parsed.calls);
    expect(aligned.dosages).toEqual([1, 2, DOSAGE_MISSING]);
  });

  it("AncestryDNA ayristirilir ve AYNI sonucu verir", () => {
    // Iki bicim ayni kisiyi tarif ediyorsa dozajlar da ayni olmali.
    const parsed = parseConsumerGenotypes(ANCESTRY);
    const aligned = alignToPanel(PANEL, parsed.calls);
    expect(aligned.dosages).toEqual([1, 2, DOSAGE_MISSING]);
  });

  it("yorum ve baslik satirlari veri sayilmaz", () => {
    const parsed = parseConsumerGenotypes(ANCESTRY);
    expect(parsed.lines).toBe(3);
    expect(parsed.skipped).toBe(0);
  });
});
