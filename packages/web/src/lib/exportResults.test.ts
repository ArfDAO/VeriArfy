import { describe, expect, it } from "vitest";

import { buildCsv, buildJson } from "./exportResults";

const provenance = {
  queryId: 0, requestId: 0, cohortSize: 10, chainId: 11155111,
  protocolAddress: "0x273FF690e1070e9F18ebef4823c2bC73D3E40AAE",
  exportedAt: "2026-09-29T00:00:00.000Z",
};

const snp = {
  rsid: "rs4680", snp: 8, table: [[4, 2, 0], [0, 2, 1]],
  chi2: 4.5, p: 0.1054, pAdjusted: 0.3162, reliable: false,
  oddsRatio: 10, oddsRatioCi: [1.026, 97.505] as [number, number],
  fisherP: 0.2381, controlMaf: 0.1667, caseMaf: 0.3333, hweP: 0.6242,
};

describe("sonuc disa aktarimi", () => {
  it("koken bilgisini dosyanin basina yazar", () => {
    const csv = buildCsv(provenance, [snp], []);
    expect(csv).toContain("# sorgu=0 talep=0");
    expect(csv).toContain("# kohort=10");
    expect(csv).toContain("0x273FF690e1070e9F18ebef4823c2bC73D3E40AAE");
  });

  it("sayimlari ve istatistikleri satira dizer", () => {
    const line = buildCsv(provenance, [snp], []).split("\n").find((l) => l.startsWith("rs4680"));
    expect(line).toBeDefined();
    expect(line!.split(",").slice(2, 8)).toEqual(["4", "2", "0", "0", "2", "1"]);
  });

  it("hesaplanamayan degeri bos birakir, NaN yazmaz", () => {
    const csv = buildCsv(provenance, [{ ...snp, oddsRatio: NaN, oddsRatioCi: [NaN, NaN], fisherP: null }], []);
    expect(csv).not.toContain("NaN");
  });

  it("JSON'da hesaplanamayan deger null olur", () => {
    const parsed = JSON.parse(buildJson(provenance, [{ ...snp, oddsRatio: NaN, oddsRatioCi: [NaN, NaN] }], []));
    expect(parsed.genomic[0].allelicOddsRatio.estimate).toBeNull();
    expect(parsed.genomic[0].counts.control).toEqual([4, 2, 0]);
    expect(parsed.provenance.cohortSize).toBe(10);
  });

  it("virgul iceren metni tirnak icine alir", () => {
    const csv = buildCsv(provenance, [], [{
      code: "a,b", unit: "mg/dL",
      control: { n: 6, mean: 1, sd: 2 }, cases: { n: 3, mean: 2, sd: 1 },
      t: 1, p: 0.5, cohensD: 0.3,
    }]);
    expect(csv).toContain('"a,b"');
  });
});
