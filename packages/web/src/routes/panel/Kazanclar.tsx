import { userError } from "../../lib/userError";
import { useCallback, useEffect, useState } from "react";

import { SEPOLIA_CHAIN_ID } from "../../config";
import { claimReward, formatToken, readDashboard, type DashboardState, type QuerySummary } from "../../lib/protocol";
import { useSession } from "../../lib/session";

const shortAddress = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`;

const stageLabel: Record<QuerySummary["stage"], string> = {
  "onay-bekliyor": "Onay bekliyor",
  "itiraz-suresi": "Itiraz suresinde",
  "yurutme-bekliyor": "Cozum bekliyor",
  iptal: "Iptal edildi",
  "paylasim-bekliyor": "Paylasim bekliyor",
  paylasildi: "Paylasildi",
  iade: "Iade edildi",
};

function requestedFields(query: QuerySummary): string {
  const snps = query.requestedSnps.length ? `SNP #${query.requestedSnps.join(", #")}` : "";
  const metrics = query.requestedMetrics.length ? `Metrik #${query.requestedMetrics.join(", #")}` : "";
  return [snps, metrics].filter(Boolean).join(" · ") || "Alan ayrintisi zincirde yok";
}

export function Kazanclar() {
  const { address, chainId, provider, signer, error: sessionError } = useSession();
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!provider || !address || chainId !== SEPOLIA_CHAIN_ID) return;
    setLoading(true);
    setError(null);
    try {
      setState(await readDashboard(provider, address));
    } catch (nextError) {
      setState(null);
      setError(userError(nextError, "Kazanclar zincirden okunamadi."));
    } finally {
      setLoading(false);
    }
  }, [address, chainId, provider]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const claim = useCallback(async (queryId: number) => {
    if (!signer) return;
    setClaiming(queryId);
    setError(null);
    try {
      await claimReward(signer, queryId);
      await refresh();
    } catch (nextError) {
      setError(userError(nextError, "Odul cekilemedi."));
    } finally {
      setClaiming(null);
    }
  }, [refresh, signer]);

  const wrongNetwork = chainId !== null && chainId !== SEPOLIA_CHAIN_ID;
  const decimals = state?.token.decimals ?? 6;
  const symbol = state?.token.symbol ?? "";

  return (
    <section className="earnings" aria-labelledby="earnings-title">
      <div className="earnings__heading">
        <div>
          <span className="eyebrow">VERI SAHIBI / KAZANCLAR</span>
          <h1 id="earnings-title">Veriniz kullanildiginda payinizi alin</h1>
          <p>Her tutar ve durum zincirden okunur. Odeme agirligi, yalnizca kapsadiginiz alanlara ve nadirlik katsayisina dayanir.</p>
        </div>
        <button className="pill pill--ghost" disabled={loading || wrongNetwork} onClick={() => void refresh()}>
          {loading ? "Okunuyor..." : "Yenile"}
        </button>
      </div>

      {wrongNetwork && <div className="notice notice--warn">Kazanclar yalnizca Sepolia aginda okunabilir.</div>}
      {(error || sessionError) && <div className="notice notice--warn">{error ?? sessionError}</div>}

      <div className="earnings__summary card card--bone">
        <span className="eyebrow">CEKILEBILIR TOPLAM</span>
        <strong className="mono">
          {state ? formatToken(state.pendingTotal, decimals, symbol) : "-"}
        </strong>
        <p>Her satirdaki cekim, basarili islemden sonra zincirden yeniden dogrulanir.</p>
      </div>

      {!loading && state?.queries.length === 0 && (
        <div className="card">
          <h2>Henuz sorgu yok</h2>
          <p className="card__body">Arastirmaci alan secip sorgu actiginda, bu ekranda kapsamaniz ve odul durumunuz gorunecek.</p>
        </div>
      )}

      <div className="earnings__list">
        {state?.queries.map((query) => (
          <article className="earnings__query card" key={query.id}>
            <div className="earnings__query-head">
              <div>
                <span className="eyebrow">SORGU #{query.id}</span>
                <h2>{shortAddress(query.researcher)}</h2>
              </div>
              <span className="tag">{stageLabel[query.stage]}</span>
            </div>

            <div className="earnings__fields">
              <span className="eyebrow">ISTENEN ALANLAR</span>
              <span className="mono">{requestedFields(query)}</span>
            </div>

            <dl className="earnings__facts">
              <div><dt>KAPSAMANIZ</dt><dd>{query.coverageWeight} alan</dd></div>
              <div><dt>ODEME AGIRLIGINIZ</dt><dd>{query.weightedCoverage}/{query.weightedTotal || 0}</dd></div>
              <div><dt>HAKEDIS</dt><dd>{formatToken(query.claimable, decimals, symbol)}</dd></div>
              <div><dt>DURUM</dt><dd>{query.claimed ? "Cekildi" : stageLabel[query.stage]}</dd></div>
            </dl>

            <p className="earnings__explanation">
              Havuzdaki toplam kapsama: {query.coverageTotal}. Nadirlik katsayisi odeme agirligina dahildir;
              {query.weightedCoverage > query.coverageWeight * 10_000 ? " bu sorguda nadir alan primi var." : " bu sorguda ek nadirlik primi yok."}
            </p>

            {query.claimed ? (
              <span className="eyebrow">CEKILDI</span>
            ) : query.claimable > 0n ? (
              <button className="pill pill--primary" disabled={claiming !== null} onClick={() => void claim(query.id)}>
                {claiming === query.id ? "Cekiliyor..." : `${formatToken(query.claimable, decimals, symbol)} cek`}
              </button>
            ) : (
              <span className="eyebrow">{query.refunded ? "IADE EDILDI" : "HENUZ CEKILEBILIR DEGIL"}</span>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
