import { userError } from "../../lib/userError";
import { useCallback, useEffect, useState } from "react";
import {
  benjaminiHochberg,
  chiSquareTest,
  compareGroups,
  formatP,
  summarizeGenomicTable,
} from "@veriarfy/study";

import { CONTRACTS, SEPOLIA_CHAIN_ID } from "../../config";
import { buildCsv, buildJson, downloadText } from "../../lib/exportResults";
import {
  collectDisclosureHandles,
  findOpenQuery,
  readDisclosure,
  settleQuery,
  type DisclosureState,
} from "../../lib/protocol";
import { userDecrypt } from "../../lib/fhe";
import { decodeAggregate, type MetricSpec } from "../../lib/metrics";
import { useSession } from "../../lib/session";
import { GENOMIC_PANEL, METRIC_PANEL } from "../../lib/studyPanel";
import { useT } from "../../lib/i18n";

interface OpenQuery {
  queryId: number;
  requestId: number;
}

interface SnpResult {
  snp: number;
  rsid: string;
  table: number[][];
  chi2: number;
  p: number;
  pAdjusted: number;
  reliable: boolean;
  /**
   * Ki-kare disindaki standart ozetler.
   *
   * Hepsi AYNI tablodan turetilir - ek bir zincir cagrisi ya da ek bir acilim
   * yetkisi gerektirmez. Bir makalede p-degerinden once bunlar raporlanir:
   * p yalnizca "fark var mi" der, odds orani ve guven araligi farkin BUYUKLUGUNU
   * ve ne kadar belirsiz oldugunu soyler. Kucuk orneklemde aralik cok genis
   * cikar; bu bir kusur degil, dogru bilgidir.
   */
  oddsRatio: number;
  oddsRatioCi: [number, number];
  oddsRatioNote: string | null;
  /** Beklenen hucreler 5'in altindayken ki-kare yerine gecerli olan exact test. */
  fisherP: number | null;
  controlMaf: number;
  caseMaf: number;
  /** HWE yalniz KONTROL grubunda anlamlidir; vakada sapma iliskinin kendisinden gelebilir. */
  hweP: number;
  hweReliable: boolean;
}

interface MetricResult {
  metric: number;
  code: string;
  unit: string;
  control: { n: number; mean: number; sd: number };
  cases: { n: number; mean: number; sd: number };
  t: number;
  p: number;
  cohensD: number;
  note: string | null;
}

export function Sonuclar() {
  const t = useT();
  const { address, chainId, provider, signer } = useSession();
  const [open, setOpen] = useState<OpenQuery | null>(null);
  const [disclosure, setDisclosure] = useState<DisclosureState | null>(null);
  const [snps, setSnps] = useState<SnpResult[] | null>(null);
  const [metrics, setMetrics] = useState<MetricResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [settling, setSettling] = useState(false);
  const [notice, setNotice] = useState<{ kind: "warn" | "ok" | "info"; text: string } | null>(null);
  const wrongNetwork = chainId !== null && chainId !== SEPOLIA_CHAIN_ID;

  const refresh = useCallback(async () => {
    if (!provider || !address || chainId !== SEPOLIA_CHAIN_ID) return;
    setLoading(true);
    setNotice(null);
    try {
      const current = await findOpenQuery(provider, address);
      if (!current) {
        setOpen(null);
        setDisclosure(null);
        return;
      }
      const state = await readDisclosure(provider, current.requestId, 4);
      setOpen({ queryId: current.queryId, requestId: current.requestId });
      setDisclosure(state);
    } catch (error) {
      setOpen(null);
      setDisclosure(null);
      setNotice({ kind: "warn", text: userError(error, "Cozum durumu zincirden okunamadi.") });
    } finally {
      setLoading(false);
    }
  }, [address, chainId, provider]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const analyze = useCallback(async () => {
    if (!provider || !signer || !disclosure?.executed) return;
    setAnalyzing(true);
    setNotice({ kind: "info", text: "Sifreli grup toplamlari arastirmaci imzasiyla cozuluyor..." });
    try {
      const { contingency, biomarkers, pairs } = await collectDisclosureHandles(provider, disclosure);
      const clear = await userDecrypt(pairs, signer as any);
      const value = (handle: string) => Number(clear[handle.toLowerCase()] ?? 0n);

      const raw = contingency.map(({ snp, cells }: any) => {
        const table = cells.map((row: string[]) => row.map(value));
        return { snp, table, ...chiSquareTest(table), summary: summarizeGenomicTable(table) };
      });
      const adjusted = benjaminiHochberg(raw.map((result: any) => result.p));
      setSnps(raw.map((result: any, index: number) => {
        const { association, groups } = result.summary;
        return {
          snp: result.snp,
          rsid: GENOMIC_PANEL.variants[result.snp]?.rsid ?? `#${result.snp}`,
          table: result.table,
          chi2: result.chi2,
          p: result.p,
          pAdjusted: adjusted[index],
          reliable: result.reliable,
          oddsRatio: association.oddsRatio.oddsRatio,
          oddsRatioCi: association.oddsRatio.ci95,
          oddsRatioNote: association.oddsRatio.note,
          fisherP: association.fisher ? association.fisher.p : null,
          controlMaf: groups[0].frequencies.maf,
          caseMaf: groups[1].frequencies.maf,
          hweP: groups[0].hwe.p,
          hweReliable: groups[0].hwe.reliable,
        };
      }));

      const grouped = new Map<number, Record<number, { n: number; sum: number; sumSq: number }>>();
      for (const item of biomarkers) {
        const groups = grouped.get(item.metric) ?? {};
        groups[item.group] = { n: value(item.count), sum: value(item.sum), sumSq: value(item.sumSq) };
        grouped.set(item.metric, groups);
      }
      const nextMetrics: MetricResult[] = [];
      for (const [metric, groups] of grouped) {
        const spec = METRIC_PANEL.metrics[metric] as MetricSpec | undefined;
        if (!spec) continue;
        const control = groups[0] ?? { n: 0, sum: 0, sumSq: 0 };
        const cases = groups[1] ?? { n: 0, sum: 0, sumSq: 0 };
        const comparison = compareGroups(control, cases);
        nextMetrics.push({
          metric,
          code: spec.code,
          unit: spec.unit,
          control: decodeAggregate(control, spec),
          cases: decodeAggregate(cases, spec),
          t: comparison.t,
          p: comparison.p,
          cohensD: comparison.cohensD,
          note: comparison.note,
        });
      }
      setMetrics(nextMetrics);
      setNotice({ kind: "ok", text: `${pairs.length} sifreli handle icinden yalnizca grup toplamlari cozuldu; ki-kare, Welch t ve BH-FDR hesaplandi.` });
    } catch (error) {
      setNotice({ kind: "warn", text: userError(error, "Sifreli toplamlar cozulup analiz edilemedi.") });
    } finally {
      setAnalyzing(false);
    }
  }, [disclosure, provider, signer]);

  const settle = useCallback(async () => {
    if (!signer || !open || !snps) return;
    setSettling(true);
    setNotice({ kind: "info", text: "Odeme protokol kurallarina gore dagitiliyor..." });
    try {
      await settleQuery(signer, open.queryId);
      setNotice({ kind: "ok", text: "Odeme dagitildi. Veri sahiplerinin cekilebilir paylari zincirde olustu." });
      await refresh();
    } catch (error) {
      setNotice({ kind: "warn", text: userError(error, "Odeme dagitilamadi.") });
    } finally {
      setSettling(false);
    }
  }, [open, refresh, signer, snps]);

  /**
   * Cozulmus sonuclari dosyaya yazar.
   *
   * Koken bilgisi (sorgu, talep, kohort buyuklugu, zincir, protokol adresi)
   * dosyaya gomulur: sayilar tek baslarina dogrulanabilir degildir ve nereden
   * geldikleri yazili olmazsa sonradan ayni sonuca geri donulemez.
   */
  const exportResults = useCallback(
    (format: "csv" | "json") => {
      if (!snps || !open) return;

      const provenance = {
        queryId: open.queryId,
        requestId: open.requestId,
        cohortSize: disclosure?.snapshotCount ?? 0,
        chainId: SEPOLIA_CHAIN_ID,
        protocolAddress: CONTRACTS.VeriarfyProtocol,
        exportedAt: new Date().toISOString(),
      };

      const rows = snps.map((result) => ({
        rsid: result.rsid,
        snp: result.snp,
        table: result.table,
        chi2: result.chi2,
        p: result.p,
        pAdjusted: result.pAdjusted,
        reliable: result.reliable,
        oddsRatio: result.oddsRatio,
        oddsRatioCi: result.oddsRatioCi,
        fisherP: result.fisherP,
        controlMaf: result.controlMaf,
        caseMaf: result.caseMaf,
        hweP: result.hweP,
      }));

      const metricRows = (metrics ?? []).map((result) => ({
        code: result.code,
        unit: result.unit,
        control: result.control,
        cases: result.cases,
        t: result.t,
        p: result.p,
        cohensD: result.cohensD,
      }));

      const base = `veriarfy-sorgu-${open.queryId}`;
      if (format === "csv") {
        downloadText(`${base}.csv`, buildCsv(provenance, rows, metricRows), "text/csv");
      } else {
        downloadText(`${base}.json`, buildJson(provenance, rows, metricRows), "application/json");
      }
    },
    [disclosure?.snapshotCount, metrics, open, snps],
  );

  return (
    <section className="research-results" aria-labelledby="research-results-title">
      <div className="research-results__heading">
        <div><span className="eyebrow">{t("ARASTIRMACI / SONUCLAR")}</span><h1 id="research-results-title">{t("Sifreli toplamdan istatistige")}</h1><p>Hicbir bireysel deger cozulmez; yalnizca grup kontenjans hucreleri ve (n, sum, sumSq) toplamlari kullanilir.</p></div>
        <button className="pill pill--ghost" disabled={loading || wrongNetwork} onClick={() => void refresh()}>{loading ? t("Okunuyor...") : t("Yenile")}</button>
      </div>
      {wrongNetwork && <div className="notice notice--warn">{t("Sonuclar yalnizca Sepolia aginda okunabilir.")}</div>}
      {notice && <div className={`notice notice--${notice.kind}`} role="status">{notice.text}</div>}
      {!loading && !open && <div className="card card--bone"><h2>{t("Cozulmus acik sorgu yok")}</h2><p className="card__body">{t("Sorgular ekraninda acilim yetkisi verildikten sonra burada analiz yapabilirsiniz.")}</p></div>}
      {open && !disclosure?.executed && <div className="notice notice--info">Sorgu #{open.queryId} henuz cozum yetkisi almadi. Itiraz penceresi ve acilim adimini Sorgular ekranindan takip edin.</div>}
      {disclosure?.executed && <div className="research-results__action card card--bone"><div><span className="eyebrow">SORGU #{open?.queryId}</span><h2>{t("Grup toplamini coz ve hesapla")}</h2><p>{t("Ki-kare ve BH-FDR genomik tablolarda; Welch t ve Cohen d biyobelirtec tablolarinda gosterilir.")}</p></div><button className="pill pill--primary" disabled={analyzing || !signer} onClick={() => void analyze()}>{analyzing ? t("Cozuluyor...") : t("Toplamlari coz ve analiz et")}</button></div>}
      {snps && <article className="research-results__table card"><div className="card__head"><h2>{t("Genomik sonuc")}</h2><span className="eyebrow">{t("KI-KARE + BH-FDR")}</span></div><div className="table"><div className="table__head table__head--gwas"><span>{t("VARYANT")}</span><span>{t("KONTROL 0/1/2")}</span><span>{t("VAKA 0/1/2")}</span><span>{t("CHI2")}</span><span>{t("p")}</span><span>{t("p (FDR)")}</span></div>{snps.map((result) => <div className={`table__row table__row--gwas${result.pAdjusted < 0.05 ? " is-hit" : ""}`} key={result.snp}><span className="mono">{result.rsid}</span><span className="mono">{result.table[0].join(" / ")}</span><span className="mono">{result.table[1].join(" / ")}</span><span className="mono">{Number.isFinite(result.chi2) ? result.chi2.toFixed(2) : "-"}</span><span className="mono">{formatP(result.p)}</span><span className="mono">{formatP(result.pAdjusted)}</span></div>)}</div>{snps.some((result) => !result.reliable) && <div className="notice notice--warn">{t("Bazı varyantlarda beklenen hucre sayisi 5'in altinda; ki-kare yaklasimi guvenilir degil.")}</div>}</article>}
      {snps && <article className="research-results__table card"><div className="card__head"><h2>{t("Etki buyuklugu ve kalite")}</h2><span className="eyebrow">{t("ODDS ORANI + HWE")}</span></div><div className="table"><div className="table__head table__head--effect"><span>{t("VARYANT")}</span><span>{t("ODDS ORANI (%95 CI)")}</span><span>{t("FISHER p")}</span><span>{t("MAF K/V")}</span><span>{t("HWE p (KONTROL)")}</span></div>{snps.map((result) => <div className="table__row table__row--effect" key={result.snp}><span className="mono">{result.rsid}</span><span className="mono">{Number.isFinite(result.oddsRatio) ? `${result.oddsRatio.toFixed(2)} (${result.oddsRatioCi[0].toFixed(2)}–${result.oddsRatioCi[1].toFixed(2)})` : "-"}</span><span className="mono">{result.fisherP === null ? "-" : formatP(result.fisherP)}</span><span className="mono">{Number.isFinite(result.controlMaf) ? `${result.controlMaf.toFixed(2)} / ${result.caseMaf.toFixed(2)}` : "-"}</span><span className="mono">{Number.isFinite(result.hweP) ? formatP(result.hweP) : "-"}</span></div>)}</div><div className="notice notice--info">{t("Odds orani alel sayimlarindan hesaplanir. Guven araligi genisse etkinin yonu bile belirsizdir; kucuk kohortta beklenen durum budur. Beklenen hucre 5'in altindayken ki-kare yerine Fisher exact p gecerlidir. HWE yalniz kontrol grubunda degerlendirilir - vakadaki sapma iliskinin kendisinden gelebilir.")}</div>{snps.some((result) => result.oddsRatioNote) && <div className="notice notice--warn">{t("Bazı varyantlarda sifir alel hucresi var; odds orani hesaplanamadi.")}</div>}</article>}
      {snps && <div className="row research-results__export"><button className="pill" onClick={() => exportResults("csv")}>{t("CSV indir")}</button><button className="pill" onClick={() => exportResults("json")}>{t("JSON indir")}</button></div>}
      {metrics && metrics.length > 0 && <article className="research-results__table card"><div className="card__head"><h2>{t("Biyobelirtec sonucu")}</h2><span className="eyebrow">{t("WELCH t + COHEN d")}</span></div><div className="table"><div className="table__head table__head--welch"><span>{t("METRIK")}</span><span>{t("KONTROL")}</span><span>{t("VAKA")}</span><span>{t("t / d")}</span><span>{t("p")}</span></div>{metrics.map((result) => <div className="table__row table__row--welch" key={result.metric}><span className="mono">{result.code}</span><span className="mono">{result.control.n ? `${result.control.mean.toFixed(2)} ± ${result.control.sd.toFixed(2)} (n=${result.control.n})` : "-"}</span><span className="mono">{result.cases.n ? `${result.cases.mean.toFixed(2)} ± ${result.cases.sd.toFixed(2)} (n=${result.cases.n})` : "-"}</span><span className="mono">{Number.isFinite(result.t) ? `${result.t.toFixed(2)} / ${result.cohensD.toFixed(2)}` : "-"}</span><span className="mono">{formatP(result.p)}</span></div>)}</div>{metrics.some((result) => result.note) && <div className="notice notice--info">{t("Bazı metriklerde her grupta en az iki katilimci olmadigi icin Welch t-testi hesaplanamiyor.")}</div>}</article>}
      {snps && open && <button className="pill pill--primary research-results__settle" disabled={settling || !signer} onClick={() => void settle()}>{settling ? t("Dagitiliyor...") : t("Analizi onayla ve odemeyi dagit")}</button>}
    </section>
  );
}
