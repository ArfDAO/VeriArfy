import { userError } from "../../lib/userError";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { SEPOLIA_CHAIN_ID } from "../../config";
import {
  formatToken,
  readContributionState,
  readPoolMembership,
  type ContributionState,
  type PoolMembershipState,
} from "../../lib/protocol";
import { useSession } from "../../lib/session";

interface OwnerOverview {
  contribution: ContributionState;
  membership: PoolMembershipState;
}

export function Ozet() {
  const navigate = useNavigate();
  const { address, chainId, provider } = useSession();
  const [overview, setOverview] = useState<OwnerOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!provider || !address || chainId !== SEPOLIA_CHAIN_ID) return;
    setLoading(true);
    setError(null);
    try {
      const [contribution, membership] = await Promise.all([
        readContributionState(provider, address),
        readPoolMembership(provider, address),
      ]);
      setOverview({ contribution, membership });
    } catch (nextError) {
      setOverview(null);
      setError(userError(nextError, "Panel zincirden okunamadi."));
    } finally {
      setLoading(false);
    }
  }, [address, chainId, provider]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const wrongNetwork = chainId !== null && chainId !== SEPOLIA_CHAIN_ID;
  const coveredFields = overview
    ? overview.contribution.coveredSnps + overview.contribution.coveredMetrics
    : 0;
  const totalFields = overview
    ? overview.contribution.snpCount + overview.contribution.metricCount
    : 0;
  const hasContribution = overview?.contribution.isEnrolled === true || coveredFields > 0;
  const membership = overview?.membership;

  return (
    <section className="owner-overview" aria-labelledby="owner-overview-title">
      <div className="owner-overview__heading">
        <div>
          <span className="eyebrow">VERI SAHIBI / GENEL BAKIS</span>
          <h1 id="owner-overview-title">Verinizin havuzdaki durumu</h1>
          <p>Katki ve odul verileri tarayicida tutulmaz; her yenilemede zincirden okunur.</p>
        </div>
        <button className="pill pill--ghost" disabled={loading || wrongNetwork} onClick={() => void refresh()}>
          {loading ? "Okunuyor..." : "Yenile"}
        </button>
      </div>

      {wrongNetwork && (
        <div className="notice notice--warn" role="status">
          Genel bakis yalnizca Sepolia agindaki sozlesmeden okunabilir.
        </div>
      )}
      {error && <div className="notice notice--warn">{error}</div>}

      <div className="owner-overview__metrics" aria-live="polite">
        <article className="owner-overview__metric card">
          <span className="eyebrow">HAVUZ KATILIMCISI</span>
          <strong className="mono">{overview ? overview.membership.poolParticipants : "-"}</strong>
          <p>{membership?.membership.active ? "Cuzdaniniz aktif havuz uyesi." : "Henuz aktif havuz uyeligi yok."}</p>
        </article>
        <article className="owner-overview__metric card">
          <span className="eyebrow">KAPSADIGINIZ ALAN</span>
          <strong className="mono">{overview ? `${coveredFields}/${totalFields}` : "-"}</strong>
          <p>Eksik isaretli alanlar kapsama sayisina dahil edilmez.</p>
        </article>
        <article className="owner-overview__metric card">
          <span className="eyebrow">TOPLAM KAZANC</span>
          <strong className="mono">
            {membership?.totalEarnings === null
              ? "Okunamadi"
              : membership
                ? formatToken(membership.totalEarnings, membership.token.decimals, membership.token.symbol)
                : "-"}
          </strong>
          <p>Cekilmis oduller ile bekleyen odullerin toplami.</p>
        </article>
        <article className="owner-overview__metric card">
          <span className="eyebrow">BEKLEYEN ODUL</span>
          <strong className="mono">
            {membership
              ? formatToken(membership.pendingRewards, membership.token.decimals, membership.token.symbol)
              : "-"}
          </strong>
          <p>Oduller sekmesinden cekilebilir tutar.</p>
        </article>
      </div>

      {!loading && !wrongNetwork && !error && !hasContribution && (
        <aside className="owner-overview__next card card--bone">
          <div>
            <span className="eyebrow">SIRADAKI ADIM</span>
            <h2>Verinizi sifreleyip havuza katin</h2>
            <p>Once grup kaydini olusturur, sonra genomik ve biyobelirtec alanlarini cihazinizi terk etmeden sifrelersiniz.</p>
          </div>
          <button className="pill pill--primary" onClick={() => navigate("/panel/veri-yukle")}>
            Veri yuklemeye git
          </button>
        </aside>
      )}
    </section>
  );
}
