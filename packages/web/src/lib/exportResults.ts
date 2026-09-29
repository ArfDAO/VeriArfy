/**
 * Cozulmus sonuclari indirilebilir dosyaya cevirir.
 *
 * NEDEN GEREKLI: sonuclar yalnizca ekranda duruyordu. Arastirmaci ucretini
 * odedigi ciktiyi kendi analizinde ya da bir yayinda kullanmak icin sayilari
 * elle kopyalamak zorundaydi - hem zahmetli hem de kopyalama hatasina acik.
 *
 * KOKEN BILGISI DOSYAYA YAZILIR. Sayilar tek baslarina dogrulanabilir degil;
 * hangi sorgudan, hangi kohort buyuklugunden ve hangi blok yuksekliginden
 * geldikleri yazili olmazsa uc ay sonra kimse ayni sonuca geri donemez.
 */
export interface ExportSnpRow {
  rsid: string;
  snp: number;
  table: number[][];
  chi2: number;
  p: number;
  pAdjusted: number;
  reliable: boolean;
  oddsRatio: number;
  oddsRatioCi: [number, number];
  fisherP: number | null;
  controlMaf: number;
  caseMaf: number;
  hweP: number;
}

export interface ExportMetricRow {
  code: string;
  unit: string;
  control: { n: number; mean: number; sd: number };
  cases: { n: number; mean: number; sd: number };
  t: number;
  p: number;
  cohensD: number;
}

export interface ExportProvenance {
  queryId: number;
  requestId: number;
  cohortSize: number;
  chainId: number;
  protocolAddress: string;
  exportedAt: string;
}

/** Sonsuz/NaN degerler CSV'de bos birakilir; "NaN" metni sayi sutununu bozar. */
function num(value: number, digits = 6): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "";
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function buildCsv(
  provenance: ExportProvenance,
  snps: ExportSnpRow[],
  metrics: ExportMetricRow[],
): string {
  const lines: string[] = [];

  // Koken satirlari yorum olarak basa yazilir: R ve pandas `#` ile baslayan
  // satirlari atlayabiliyor, yani dosya hem okunabilir hem dogrudan yuklenebilir.
  lines.push(`# VeriArfy sonuc disa aktarimi`);
  lines.push(`# sorgu=${provenance.queryId} talep=${provenance.requestId}`);
  lines.push(`# kohort=${provenance.cohortSize} chainId=${provenance.chainId}`);
  lines.push(`# protokol=${provenance.protocolAddress}`);
  lines.push(`# tarih=${provenance.exportedAt}`);

  if (snps.length > 0) {
    lines.push("");
    lines.push("# genomik");
    lines.push(
      [
        "rsid", "snp_id",
        "kontrol_0", "kontrol_1", "kontrol_2",
        "vaka_0", "vaka_1", "vaka_2",
        "chi2", "p", "p_fdr", "chi2_guvenilir",
        "fisher_p", "odds_orani", "or_ci_alt", "or_ci_ust",
        "kontrol_maf", "vaka_maf", "hwe_p_kontrol",
      ].join(","),
    );
    for (const row of snps) {
      lines.push([
        csvCell(row.rsid), String(row.snp),
        ...row.table[0].map(String), ...row.table[1].map(String),
        num(row.chi2, 4), num(row.p), num(row.pAdjusted), row.reliable ? "evet" : "hayir",
        row.fisherP === null ? "" : num(row.fisherP),
        num(row.oddsRatio, 4), num(row.oddsRatioCi[0], 4), num(row.oddsRatioCi[1], 4),
        num(row.controlMaf, 4), num(row.caseMaf, 4), num(row.hweP),
      ].join(","));
    }
  }

  if (metrics.length > 0) {
    lines.push("");
    lines.push("# biyobelirtec");
    lines.push(
      [
        "metrik", "birim",
        "kontrol_n", "kontrol_ortalama", "kontrol_ss",
        "vaka_n", "vaka_ortalama", "vaka_ss",
        "t", "p", "cohens_d",
      ].join(","),
    );
    for (const row of metrics) {
      lines.push([
        csvCell(row.code), csvCell(row.unit),
        String(row.control.n), num(row.control.mean, 4), num(row.control.sd, 4),
        String(row.cases.n), num(row.cases.mean, 4), num(row.cases.sd, 4),
        num(row.t, 4), num(row.p), num(row.cohensD, 4),
      ].join(","));
    }
  }

  return `${lines.join("\n")}\n`;
}

export function buildJson(
  provenance: ExportProvenance,
  snps: ExportSnpRow[],
  metrics: ExportMetricRow[],
): string {
  // Sonsuz/NaN JSON'da gecerli degil ve sessizce `null` olur; acikca null
  // yaziyoruz ki okuyan taraf "hesaplanamadi" ile "sifir" arasinda ayrim yapabilsin.
  const clean = (value: number) => (Number.isFinite(value) ? value : null);
  return `${JSON.stringify(
    {
      provenance,
      genomic: snps.map((row) => ({
        rsid: row.rsid,
        snpId: row.snp,
        counts: { control: row.table[0], case: row.table[1] },
        chiSquare: { chi2: clean(row.chi2), p: clean(row.p), pAdjusted: clean(row.pAdjusted), reliable: row.reliable },
        fisherExactP: row.fisherP === null ? null : clean(row.fisherP),
        allelicOddsRatio: { estimate: clean(row.oddsRatio), ci95: [clean(row.oddsRatioCi[0]), clean(row.oddsRatioCi[1])] },
        minorAlleleFrequency: { control: clean(row.controlMaf), case: clean(row.caseMaf) },
        hardyWeinbergControlsP: clean(row.hweP),
      })),
      biomarkers: metrics.map((row) => ({
        code: row.code,
        unit: row.unit,
        control: { n: row.control.n, mean: clean(row.control.mean), sd: clean(row.control.sd) },
        case: { n: row.cases.n, mean: clean(row.cases.mean), sd: clean(row.cases.sd) },
        welch: { t: clean(row.t), p: clean(row.p), cohensD: clean(row.cohensD) },
      })),
    },
    null,
    2,
  )}\n`;
}

/** Metni dosya olarak indirtir. */
export function downloadText(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Hemen serbest birakmak bazi tarayicilarda indirmeyi yarida kesiyor.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
