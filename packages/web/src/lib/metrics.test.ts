import { describe, expect, it } from "vitest";
import { compareGroups } from "@veriarfy/study";

import {
  BIOMARKER_MISSING,
  alignToMetrics,
  decodeAggregate,
  decodeValue,
  encodeValue,
  metricsDigest,
  summarizeSeries,
  type MetricPanel,
  type MetricSpec,
} from "./metrics";

/**
 * Metrik hizalamasi ve zaman serisi indirgemesi — veri kategorisi 2.
 *
 * `panel.test.ts` genomik tarafta "iki kullanicinin ayni indeksi ayni varyant
 * mi" sorusunu kovaliyordu. Burada ayni soru bir kat daha zor: indeks AYNI
 * metrik olmali VE ayni BIRIMDE olmali.
 */

const VO2: MetricSpec = {
  code: "VO2MAX",
  unit: "ml/kg/min",
  scale: 100,
  offset: 0,
  minValue: 1500, // 15,0
  maxValue: 9000, // 90,0
};

/**
 * Kreatin kinaz onarim hizi — ISARETLI bir metrik.
 *
 * Iyilesme, CK'nin DUSMESI demektir; yani beklenen egim negatiftir. Kodlanmis
 * degerler `uint32` oldugu icin bu ancak `offset` ile temsil edilebilir.
 */
const CK_SLOPE: MetricSpec = {
  code: "CK_SLOPE",
  unit: "U/L/day",
  scale: 1,
  offset: 20_000, // -20.000 .. +20.000 U/L/gun
  minValue: 1,
  maxValue: 40_000,
};

const PANEL: MetricPanel = {
  panelId: "veriarfy-sport-v1",
  version: 1,
  metrics: [VO2, CK_SLOPE],
};

describe("olcekleme", () => {
  it("gercek deger tamsayiya cevrilir ve geri okunur", () => {
    expect(encodeValue(52.3, VO2)).toBe(5230);
    expect(decodeValue(5230, VO2)).toBeCloseTo(52.3, 6);
  });

  it("NEGATIF deger offset ile kodlanir", () => {
    // Gunde 1.200 U/L dusus — iyilesen bir kas.
    expect(encodeValue(-1200, CK_SLOPE)).toBe(18_800);
    expect(decodeValue(18_800, CK_SLOPE)).toBe(-1200);
  });

  it("offset olmadan negatif deger KODLANAMAZ", () => {
    // Bu yuzden `offset` alani var: aksi halde iyilesen her katilimci
    // sessizce "eksik" sayilirdi.
    const noOffset: MetricSpec = { ...CK_SLOPE, offset: 0 };
    expect(encodeValue(-1200, noOffset)).toBeNull();
  });

  it("aralik disi deger KIRPILMAZ, null doner", () => {
    // Kirpma uydurma ama gecerli gorunen bir gozlem uretirdi.
    expect(encodeValue(200, VO2)).toBeNull();
    expect(encodeValue(3, VO2)).toBeNull();
  });

  it("sinir degerleri dahildir", () => {
    expect(encodeValue(15, VO2)).toBe(1500);
    expect(encodeValue(90, VO2)).toBe(9000);
  });

  it("NaN ve sonsuz reddedilir", () => {
    expect(encodeValue(NaN, VO2)).toBeNull();
    expect(encodeValue(Infinity, VO2)).toBeNull();
  });
});

describe("panele hizalama", () => {
  it("degerler PANEL sirasinda cikar, girdi sirasinda degil", () => {
    const result = alignToMetrics(PANEL, [
      { code: "CK_SLOPE", value: -1200 },
      { code: "VO2MAX", value: 52.3 },
    ]);

    expect(result.values).toEqual([5230, 18_800]);
    expect(result.coverage).toBe(1);
  });

  it("olculmemis metrik BIOMARKER_MISSING alir", () => {
    const result = alignToMetrics(PANEL, [{ code: "VO2MAX", value: 52.3 }]);

    expect(result.values).toEqual([5230, BIOMARKER_MISSING]);
    expect(result.missing).toBe(1);
    expect(result.covered).toBe(1);
  });

  it("aralik disi olcum eksik sayilir ama SESSIZCE degil", () => {
    // Kullaniciya soylenebilmeli: kapsama orani aciklanamaz sekilde dusmesin.
    const result = alignToMetrics(PANEL, [{ code: "VO2MAX", value: 200 }]);

    expect(result.values[0]).toBe(BIOMARKER_MISSING);
    expect(result.outOfRange).toEqual(["VO2MAX"]);
  });

  it("panelde olmayan olcum sessizce ATILMAZ, sayilir", () => {
    const result = alignToMetrics(PANEL, [
      { code: "VO2MAX", value: 52.3 },
      { code: "RESTING_HR", value: 48 },
    ]);

    expect(result.ignored).toBe(1);
  });

  it("IKI FARKLI kullanici ayni indekste AYNI metrigi tasir", () => {
    // Tum tasariminin sebebi bu. Farkli sirada ve farkli kapsamda gonderilen
    // olcumler yine de ayni indekse duser.
    const alice = alignToMetrics(PANEL, [
      { code: "CK_SLOPE", value: -1200 },
      { code: "VO2MAX", value: 52.3 },
    ]);
    const bob = alignToMetrics(PANEL, [{ code: "VO2MAX", value: 61.0 }]);

    expect(alice.values[0]).toBe(5230);
    expect(bob.values[0]).toBe(6100);
    expect(bob.values[1]).toBe(BIOMARKER_MISSING);
  });

  it("bos panel bolme hatasi vermez", () => {
    const empty: MetricPanel = { ...PANEL, metrics: [] };
    const result = alignToMetrics(empty, [{ code: "VO2MAX", value: 52 }]);
    expect(result.values).toEqual([]);
    expect(result.coverage).toBe(0);
  });
});

describe("panel ozeti", () => {
  it("ayni panel ayni ozeti verir", async () => {
    expect(await metricsDigest(PANEL)).toBe(await metricsDigest(PANEL));
  });

  it("OLCEK degisince ozet degisir", async () => {
    // Ayni sayinin iki farkli anlami olmasi tam olarak onlenmek istenen sey.
    const rescaled: MetricPanel = {
      ...PANEL,
      metrics: [{ ...VO2, scale: 10 }, CK_SLOPE],
    };
    expect(await metricsDigest(rescaled)).not.toBe(await metricsDigest(PANEL));
  });

  it("BIRIM degisince ozet degisir", async () => {
    const reunit: MetricPanel = {
      ...PANEL,
      metrics: [{ ...VO2, unit: "L/min" }, CK_SLOPE],
    };
    expect(await metricsDigest(reunit)).not.toBe(await metricsDigest(PANEL));
  });

  it("SIRA degisince ozet degisir", async () => {
    const reordered: MetricPanel = { ...PANEL, metrics: [CK_SLOPE, VO2] };
    expect(await metricsDigest(reordered)).not.toBe(await metricsDigest(PANEL));
  });
});

describe("zaman serisi indirgemesi", () => {
  const DAY = 86_400_000;
  const t0 = Date.UTC(2026, 0, 1);

  it("ortalama, en kucuk, en buyuk ve son deger", () => {
    const s = summarizeSeries([
      { t: t0, v: 10 },
      { t: t0 + DAY, v: 20 },
      { t: t0 + 2 * DAY, v: 30 },
    ])!;

    expect(s.n).toBe(3);
    expect(s.mean).toBe(20);
    expect(s.min).toBe(10);
    expect(s.max).toBe(30);
    expect(s.last).toBe(30);
  });

  it("egim GUN basina hesaplanir", () => {
    const s = summarizeSeries([
      { t: t0, v: 100 },
      { t: t0 + DAY, v: 200 },
      { t: t0 + 2 * DAY, v: 300 },
    ])!;
    expect(s.slopePerDay).toBeCloseTo(100, 6);
  });

  it("DUSEN seri negatif egim verir — kas onariminin isareti", () => {
    // Kreatin kinaz zirveden normale donerken duser; onarim hizi budur.
    const s = summarizeSeries([
      { t: t0, v: 8000 },
      { t: t0 + DAY, v: 5000 },
      { t: t0 + 2 * DAY, v: 2000 },
    ])!;
    expect(s.slopePerDay).toBeCloseTo(-3000, 6);
  });

  it("ornekler SIRASIZ gelse de sonuc ayni", () => {
    const ordered = summarizeSeries([
      { t: t0, v: 100 },
      { t: t0 + DAY, v: 200 },
    ])!;
    const shuffled = summarizeSeries([
      { t: t0 + DAY, v: 200 },
      { t: t0, v: 100 },
    ])!;

    expect(shuffled.slopePerDay).toBeCloseTo(ordered.slopePerDay, 9);
    expect(shuffled.last).toBe(200);
  });

  it("tek ornek egim yerine 0 verir, NaN degil", () => {
    // NaN sessizce panele sizardi ve kodlama asamasinda "eksik" olurdu —
    // sebebi anlasilmadan.
    const s = summarizeSeries([{ t: t0, v: 42 }])!;
    expect(s.slopePerDay).toBe(0);
    expect(s.mean).toBe(42);
  });

  it("bos seri null doner", () => {
    expect(summarizeSeries([])).toBeNull();
  });

  it("gecersiz ornekler atilir", () => {
    const s = summarizeSeries([
      { t: t0, v: 10 },
      { t: NaN, v: 20 },
      { t: t0 + DAY, v: Infinity },
      { t: t0 + 2 * DAY, v: 30 },
    ])!;
    expect(s.n).toBe(2);
    expect(s.mean).toBe(20);
  });

  it("mutlak zaman damgalari duyarlilik kaybettirmez", () => {
    // Egim mutlak Unix milisaniyeleriyle hesaplansaydi (1,7e12 mertebesi)
    // kareler kayan noktada duyarlilik kaybederdi. Ilk ornege gore kaydirma
    // bunu onler.
    const far = Date.UTC(2099, 0, 1);
    const s = summarizeSeries([
      { t: far, v: 1000 },
      { t: far + DAY, v: 1001 },
      { t: far + 2 * DAY, v: 1002 },
    ])!;
    expect(s.slopePerDay).toBeCloseTo(1, 6);
  });
});

describe("toplamlarin geri cevrimi", () => {
  it("kodlanmis toplamlardan gercek ortalama ve sapma", () => {
    // Iki katilimci: 42,0 ve 48,0 ml/kg/dk -> kodlanmis 4200 ve 4800.
    const decoded = decodeAggregate(
      { n: 2, sum: 4200 + 4800, sumSq: 4200 ** 2 + 4800 ** 2 },
      VO2,
    );

    expect(decoded.mean).toBeCloseTo(45, 9);
    // Ornek standart sapmasi: sqrt(((42-45)^2 + (48-45)^2) / 1) = sqrt(18)
    expect(decoded.sd).toBeCloseTo(Math.sqrt(18), 9);
  });

  it("OFFSET'li metrikte de ortalama dogru cevrilir", () => {
    // Gercek egimler: -1200 ve -800 -> kodlanmis 18.800 ve 19.200.
    const decoded = decodeAggregate(
      { n: 2, sum: 18_800 + 19_200, sumSq: 18_800 ** 2 + 19_200 ** 2 },
      CK_SLOPE,
    );

    expect(decoded.mean).toBeCloseTo(-1000, 9);
    // Sapma offset'ten ETKILENMEZ: sqrt(((-1200+1000)^2 + (-800+1000)^2)/1)
    expect(decoded.sd).toBeCloseTo(Math.sqrt(80_000), 6);
  });

  it("bos grup NaN doner, 0 degil", () => {
    // 0 "ortalama sifir" demek olurdu; dogru ifade "bilinmiyor".
    const decoded = decodeAggregate({ n: 0, sum: 0, sumSq: 0 }, VO2);
    expect(decoded.mean).toBeNaN();
  });
});

describe("uctan uca: kodlanmis toplamlardan Welch t-testi", () => {
  /** Duz metin listesinden yeterli istatistikleri uretir. */
  function aggregate(values: number[]) {
    return {
      n: values.length,
      sum: values.reduce((a, b) => a + b, 0),
      sumSq: values.reduce((a, b) => a + b * b, 0),
    };
  }

  it("t ve p, olcek ve offset'ten BAGIMSIZDIR", () => {
    // Bu, tasarimin en kritik ozelligi. Zincir kodlanmis tamsayilarla calisir;
    // eger istatistik olcege ya da sifir noktasina baglisaydi, metrik
    // tanimini degistiren her calisma farkli bir p-degeri uretirdi.
    //
    //   ortalama(kodlanmis) = ortalama(gercek) * scale + offset
    //   varyans(kodlanmis)  = varyans(gercek) * scale^2   (offset DUSER)
    //
    // t = ortalama farki / standart hata oldugundan offset yok olur ve
    // `scale` sadelesir.
    const controlReal = [42.0, 48.0, 45.5, 51.2, 44.8];
    const caseReal = [35.1, 38.4, 33.9, 40.0, 36.6];

    const real = compareGroups(aggregate(controlReal), aggregate(caseReal));

    const encode = (v: number) => encodeValue(v, VO2)!;
    const encoded = compareGroups(
      aggregate(controlReal.map(encode)),
      aggregate(caseReal.map(encode)),
    );

    expect(encoded.t).toBeCloseTo(real.t, 6);
    expect(encoded.p).toBeCloseTo(real.p, 9);
    expect(encoded.df).toBeCloseTo(real.df, 6);
    expect(encoded.cohensD).toBeCloseTo(real.cohensD, 6);

    // Ortalama farki ise OLCEKLIDIR — geri cevrilmelidir.
    expect(encoded.meanDiff / VO2.scale).toBeCloseTo(real.meanDiff, 6);
  });

  it("OFFSET'li isaretli metrikte de ayni sonuc", () => {
    const controlReal = [-1200, -1100, -1350, -1000];
    const caseReal = [-400, -520, -380, -610];

    const real = compareGroups(aggregate(controlReal), aggregate(caseReal));

    const encode = (v: number) => encodeValue(v, CK_SLOPE)!;
    const encoded = compareGroups(
      aggregate(controlReal.map(encode)),
      aggregate(caseReal.map(encode)),
    );

    expect(encoded.t).toBeCloseTo(real.t, 6);
    expect(encoded.p).toBeCloseTo(real.p, 9);
  });

  it("eksik olcumlar sayima girmedigi icin ortalama bozulmaz", () => {
    // Zincir eksik olcumu `n`'e katmaz. Katsaydi, olculmemis herkes 0 gibi
    // davranir ve ortalamayi sifira dogru cekerdi.
    const measured = [42.0, 48.0, 45.5];
    const withMissing = compareGroups(
      aggregate(measured.map((v) => encodeValue(v, VO2)!)),
      aggregate([35.1, 38.4].map((v) => encodeValue(v, VO2)!)),
    );

    expect(withMissing.a.n).toBe(3);
    expect(withMissing.a.mean / VO2.scale).toBeCloseTo(45.1667, 3);
  });
});
