import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { SEPOLIA_CHAIN_ID } from "../../config";
import {
  formatToken,
  findOpenQuery,
  getBiomarkers,
  getPayments,
  getProtocol,
  openQuery,
  QUERY_TYPE,
  readResearcherReadiness,
  type ResearcherReadiness,
} from "../../lib/protocol";
import { useSession } from "../../lib/session";
import { GENOMIC_PANEL, METRIC_PANEL } from "../../lib/studyPanel";

interface FieldCoverage {
  count: number;
  multiplierBps: number;
}

interface PurchaseState {
  readiness: ResearcherReadiness;
  snps: FieldCoverage[];
  metrics: FieldCoverage[];
}

interface Quote {
  fee: bigint;
  records: number;
}

interface ActiveQuery {
  queryId: number;
  requestId: number;
}

function multiplierBps(count: number, participants: number, cap: number): number {
  if (count === 0) return 0;
  return Math.min(Math.max(Math.floor((participants * 10_000) / count), 10_000), cap);
}

function formatMultiplier(value: number) {
  return `×${(value / 10_000).toLocaleString("tr-TR", { maximumFractionDigits: 2 })}`;
}

function selectedIds(selection: Set<number>) {
  return [...selection].sort((left, right) => left - right);
}

export function VeriAl() {
  const { address, chainId, provider, signer } = useSession();
  const [purchaseState, setPurchaseState] = useState<PurchaseState | null>(null);
  const [selectedSnps, setSelectedSnps] = useState<Set<number>>(() => new Set([0]));
  const [selectedMetrics, setSelectedMetrics] = useState<Set<number>>(() => new Set());
  const [quote, setQuote] = useState<Quote | null>(null);
  const [activeQuery, setActiveQuery] = useState<ActiveQuery | null>(null);
  const [loading, setLoading] = useState(false);
  const [pricing, setPricing] = useState(false);
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState<{ kind: "warn" | "ok" | "info"; text: string } | null>(null);

  const wrongNetwork = chainId !== null && chainId !== SEPOLIA_CHAIN_ID;
  const snpIds = useMemo(() => selectedIds(selectedSnps), [selectedSnps]);
  const metricIds = useMemo(() => selectedIds(selectedMetrics), [selectedMetrics]);

  const refresh = useCallback(async () => {
    if (!provider || !address || chainId !== SEPOLIA_CHAIN_ID) return;
    setLoading(true);
    setNotice(null);
    try {
      const protocol = getProtocol(provider);
      const biomarkers = getBiomarkers(provider);
      const payments = getPayments(provider);
      const readiness = await readResearcherReadiness(provider, address);
      const [snpCounts, metricCounts, maxScarcityBps, open] = await Promise.all([
        Promise.all(GENOMIC_PANEL.variants.map((_, index) => protocol.snpCoverageCount(index) as Promise<bigint>)),
        Promise.all(METRIC_PANEL.metrics.map((_, index) => biomarkers.metricCoverageCount(index) as Promise<bigint>)),
        payments.maxScarcityBps() as Promise<bigint>,
        findOpenQuery(provider, address),
      ]);
      const cap = Number(maxScarcityBps);

      setPurchaseState({
        readiness,
        snps: snpCounts.map((count) => {
          const total = Number(count);
          return { count: total, multiplierBps: multiplierBps(total, readiness.participants, cap) };
        }),
        metrics: metricCounts.map((count) => {
          const total = Number(count);
          return { count: total, multiplierBps: multiplierBps(total, readiness.participants, cap) };
        }),
      });
      setActiveQuery(open ? { queryId: open.queryId, requestId: open.requestId } : null);
    } catch (error) {
      setPurchaseState(null);
      setActiveQuery(null);
      setNotice({
        kind: "warn",
        text: error instanceof Error ? error.message : "Alan kapsamalari zincirden okunamadi.",
      });
    } finally {
      setLoading(false);
    }
  }, [address, chainId, provider]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!provider || chainId !== SEPOLIA_CHAIN_ID || snpIds.length === 0) {
      setQuote(null);
      return;
    }

    let current = true;
    setPricing(true);
    void getPayments(provider)
      .quoteForFields(snpIds, metricIds)
      .then((next: [bigint, bigint]) => {
        if (current) setQuote({ fee: next[0], records: Number(next[1]) });
      })
      .catch((error: unknown) => {
        if (!current) return;
        setQuote(null);
        setNotice({
          kind: "warn",
          text: error instanceof Error ? error.message : "Secilen alanlarin fiyati okunamadi.",
        });
      })
      .finally(() => {
        if (current) setPricing(false);
      });

    return () => {
      current = false;
    };
  }, [chainId, metricIds, provider, snpIds]);

  const toggle = (kind: "snp" | "metric", index: number) => {
    const setter = kind === "snp" ? setSelectedSnps : setSelectedMetrics;
    setter((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const open = useCallback(async () => {
    if (!signer || !purchaseState || !quote || activeQuery || snpIds.length === 0 || wrongNetwork) return;
    if (!purchaseState.readiness.registered || purchaseState.readiness.participants === 0) return;
    if (purchaseState.readiness.balance < quote.fee) return;

    setOpening(true);
    setNotice({ kind: "info", text: "Ucret emanete aliniyor ve secilen alanlar icin acilim talebi aciliyor..." });
    try {
      const outcome = await openQuery(signer, QUERY_TYPE.STATISTICS, { snpIds, metricIds });
      setNotice({
        kind: "ok",
        text: `Sorgu #${outcome.queryId} acildi. ${formatToken(outcome.fee, purchaseState.readiness.decimals, purchaseState.readiness.symbol)} ucret emanette; sonraki asamalar sorgular ekraninda izlenecek.`,
      });
      await refresh();
    } catch (error) {
      setNotice({
        kind: "warn",
        text: error instanceof Error ? error.message : "Sorgu acilamadi.",
      });
    } finally {
      setOpening(false);
    }
  }, [activeQuery, metricIds, purchaseState, quote, refresh, signer, snpIds, wrongNetwork]);

  const readiness = purchaseState?.readiness;
  const balanceEnough = readiness && quote ? readiness.balance >= quote.fee : false;
  const canOpen = !!(
    signer &&
    readiness?.registered &&
    readiness.participants > 0 &&
    balanceEnough &&
    quote &&
    !activeQuery &&
    snpIds.length > 0 &&
    !wrongNetwork &&
    !pricing &&
    !opening
  );

  return (
    <section className="data-purchase" aria-labelledby="data-purchase-title">
      <div className="data-purchase__heading">
        <div>
          <span className="eyebrow">ARASTIRMACI / VERI SATIN ALMA</span>
          <h1 id="data-purchase-title">Yalnizca ihtiyaciniz olan alanlari secin</h1>
          <p>Kapsama ve kitlik her yenilemede zincirden okunur. Fiyat, secilen alanlarda gercekten veri veren kisi sayisina gore hesaplanir.</p>
        </div>
        <button className="pill pill--ghost" disabled={loading || wrongNetwork} onClick={() => void refresh()}>
          {loading ? "Okunuyor..." : "Yenile"}
        </button>
      </div>

      {wrongNetwork && <div className="notice notice--warn">Veri satin alma yalnizca Sepolia aginda kullanilabilir.</div>}
      {notice && <div className={`notice notice--${notice.kind}`} role="status">{notice.text}</div>}

      <div className="data-purchase__layout">
        <div className="data-purchase__fields">
          <section className="data-purchase__group card">
            <div className="data-purchase__group-head">
              <div>
                <span className="eyebrow">GENOMIK VARYANTLAR</span>
                <h2>{selectedSnps.size} SNP secili</h2>
              </div>
              <span className="badge">en az 1 gerekli</span>
            </div>
            <div className="data-purchase__field-list">
              {GENOMIC_PANEL.variants.map((variant, index) => {
                const field = purchaseState?.snps[index];
                const selected = selectedSnps.has(index);
                return (
                  <label className={`data-purchase__field${selected ? " is-selected" : ""}`} key={variant.rsid}>
                    <input checked={selected} onChange={() => toggle("snp", index)} type="checkbox" />
                    <span className="data-purchase__field-name">
                      <strong>{variant.rsid}</strong>
                      <small>Kromozom {variant.chrom} · {variant.pos.toLocaleString("tr-TR")}</small>
                    </span>
                    <span className="data-purchase__field-value">
                      {field ? (
                        field.count === 0 ? "0 kayit · ucretsiz" : `${field.count} kayit · ${formatMultiplier(field.multiplierBps)}`
                      ) : "Okunuyor..."}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>

          <section className="data-purchase__group card">
            <div className="data-purchase__group-head">
              <div>
                <span className="eyebrow">BIYOBELIRTECLER</span>
                <h2>{selectedMetrics.size} metrik secili</h2>
              </div>
              <span className="badge">istege bagli</span>
            </div>
            <div className="data-purchase__field-list">
              {METRIC_PANEL.metrics.map((metric, index) => {
                const field = purchaseState?.metrics[index];
                const selected = selectedMetrics.has(index);
                return (
                  <label className={`data-purchase__field${selected ? " is-selected" : ""}`} key={metric.code}>
                    <input checked={selected} onChange={() => toggle("metric", index)} type="checkbox" />
                    <span className="data-purchase__field-name">
                      <strong>{metric.code}</strong>
                      <small>{metric.unit}</small>
                    </span>
                    <span className="data-purchase__field-value">
                      {field ? (
                        field.count === 0 ? "0 kayit · ucretsiz" : `${field.count} kayit · ${formatMultiplier(field.multiplierBps)}`
                      ) : "Okunuyor..."}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        </div>

        <aside className="data-purchase__quote card card--bone">
          <span className="eyebrow">ANLIK FIYAT</span>
          <strong className="data-purchase__price mono">
            {pricing ? "Hesaplaniyor..." : quote && readiness ? formatToken(quote.fee, readiness.decimals, readiness.symbol) : "-"}
          </strong>
          <p>{quote ? `${quote.records} kisi × alan kaydi seciminize dahil.` : "En az bir SNP secin."}</p>
          <dl className="data-purchase__summary">
            <div><dt>Secilen SNP</dt><dd>{snpIds.length}</dd></div>
            <div><dt>Secilen metrik</dt><dd>{metricIds.length}</dd></div>
            <div><dt>Cuzdan bakiyesi</dt><dd>{readiness ? formatToken(readiness.balance, readiness.decimals, readiness.symbol) : "-"}</dd></div>
          </dl>
          <p className="data-purchase__fineprint">Bos alanlarin degisken fiyat payi sifirdir; toplamda sorgu dogrulama/emanet maliyeti icin zincirin taban ucreti bulunabilir.</p>
          {!readiness?.registered && <div className="notice notice--warn">Once kayit ve hazirlik ekranindan arastirmaci kimliginizi dogrulayin.</div>}
          {readiness?.participants === 0 && <div className="notice notice--warn">Havuz bosken sorgu acilamaz.</div>}
          {quote && readiness && !balanceEnough && <div className="notice notice--warn">Secilen alanlar icin token bakiyesi yetersiz.</div>}
          {activeQuery && (
            <div className="notice notice--info">
              Sorgu #{activeQuery.queryId} halen acik. Ikinci bir odeme yapilamaz; ilerlemeyi <Link to="/arastirma/sorgular">sorgular ekranindan</Link> takip edin.
            </div>
          )}
          <button className="pill pill--primary" disabled={!canOpen} onClick={() => void open()}>
            {opening ? "Sorgu aciliyor..." : "Ucreti ode ve sorguyu ac"}
          </button>
        </aside>
      </div>
    </section>
  );
}
