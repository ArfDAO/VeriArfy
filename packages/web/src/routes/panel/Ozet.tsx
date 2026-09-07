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
import { useT } from "../../lib/i18n";

interface OwnerOverview {
  contribution: ContributionState;
  membership: PoolMembershipState;
}

export function Ozet() {
  const t = useT();
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
          <span className="eyebrow">{t("VERI SAHIBI / GENEL BAKIS")}</span>
          <h1 id="owner-overview-title">{t("Verinizin havuzdaki durumu")}</h1>
          <p>{t("Katki ve odul verileri tarayicida tutulmaz; her yenilemede zincirden okunur.")}</p>
        </div>
        <button className="pill pill--ghost" disabled={loading || wrongNetwork} onClick={() => void refresh()}>
          {loading ? t("Okunuyor...") : t("Yenile")}
        </button>
      </div>

      {wrongNetwork && (
        <div className="notice notice--warn" role="status">
          {t("Genel bakis yalnizca Sepolia agindaki sozlesmeden okunabilir.")}
        </div>
      )}
      {error && <div className="notice notice--warn">{error}</div>}

      <div className="owner-overview__metrics" aria-live="polite">
        <article className="owner-overview__metric card">
          <span className="eyebrow">{t("HAVUZ KATILIMCISI")}</span>
          <strong className="mono">{overview ? overview.membership.poolParticipants : "-"}</strong>
          <p>{membership?.membership.active ? t("Cuzdaniniz aktif havuz uyesi.") : t("Henuz aktif havuz uyeligi yok.")}</p>
        </article>
        <article className="owner-overview__metric card">
          <span className="eyebrow">{t("KAPSADIGINIZ ALAN")}</span>
          <strong className="mono">{overview ? `${coveredFields}/${totalFields}` : "-"}</strong>
          <p>{t("Eksik isaretli alanlar kapsama sayisina dahil edilmez.")}</p>
        </article>
        <article className="owner-overview__metric card">
          <span className="eyebrow">{t("TOPLAM KAZANC")}</span>
          <strong className="mono">
            {membership?.totalEarnings === null
              ? "Okunamadi"
              : membership
                ? formatToken(membership.totalEarnings, membership.token.decimals, membership.token.symbol)
                : "-"}
          </strong>
          <p>{t("Cekilmis oduller ile bekleyen odullerin toplami.")}</p>
        </article>
        <article className="owner-overview__metric card">
          <span className="eyebrow">{t("BEKLEYEN ODUL")}</span>
          <strong className="mono">
            {membership
              ? formatToken(membership.pendingRewards, membership.token.decimals, membership.token.symbol)
              : "-"}
          </strong>
          <p>{t("Oduller sekmesinden cekilebilir tutar.")}</p>
        </article>
      </div>

      {!loading && !wrongNetwork && !error && !hasContribution && (
        <aside className="owner-overview__next card card--bone">
          <div>
            <span className="eyebrow">{t("SIRADAKI ADIM")}</span>
            <h2>{t("Verinizi sifreleyip havuza katin")}</h2>
            <p>{t("Once grup kaydini olusturur, sonra genomik ve biyobelirtec alanlarini cihazinizi terk etmeden sifrelersiniz.")}</p>
          </div>
          <button className="pill pill--primary" onClick={() => navigate("/panel/veri-yukle")}>
            {t("Veri yuklemeye git")}
          </button>
        </aside>
      )}
    </section>
  );
}
