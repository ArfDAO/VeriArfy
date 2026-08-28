import { userError } from "../../lib/userError";
import { useCallback, useEffect, useState } from "react";

import { SEPOLIA_CHAIN_ID } from "../../config";
import { leavePool, readDashboard, readPersistence, type DashboardState, type PersistenceState } from "../../lib/protocol";
import { useSession } from "../../lib/session";

const short = (value: string) => value && value !== `0x${"0".repeat(64)}` ? `${value.slice(0, 10)}...${value.slice(-6)}` : "Kayit yok";

export function Gizlilik() {
  const { address, chainId, provider, signer } = useSession();
  const [state, setState] = useState<DashboardState | null>(null);
  const [persistence, setPersistence] = useState<PersistenceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!provider || !address || chainId !== SEPOLIA_CHAIN_ID) return;
    setError(null);
    try {
      const dashboard = await readDashboard(provider, address);
      setState(dashboard);
      setPersistence(await readPersistence(provider, dashboard.vault.cidDigest));
    } catch (nextError) {
      setError(userError(nextError, "Gizlilik durumu zincirden okunamadi."));
    }
  }, [address, chainId, provider]);

  useEffect(() => { void refresh(); }, [refresh]);

  const leave = useCallback(async () => {
    if (!signer) return;
    setBusy(true);
    setError(null);
    try {
      await leavePool(signer);
      await refresh();
    } catch (nextError) {
      setError(userError(nextError, "Havuzdan cikilamadi."));
    } finally { setBusy(false); }
  }, [refresh, signer]);

  const active = state?.membership.active === true;
  return <section className="privacy" aria-labelledby="privacy-title">
    <div className="owner-overview__heading"><div><span className="eyebrow">VERI SAHIBI / GIZLILIK</span><h1 id="privacy-title">Havuz ve veri kasasi</h1><p>Bu ekran yalnizca zincirdeki uyelik ve taahhut bilgilerini gosterir; ham veri veya sifreleme anahtari gostermez.</p></div><button className="pill pill--ghost" onClick={() => void refresh()} disabled={busy}>Yenile</button></div>
    {error && <div className="notice notice--warn">{error}</div>}
    <div className="owner-overview__metrics">
      <article className="owner-overview__metric card"><span className="eyebrow">HAVUZ DURUMU</span><strong className="mono">{active ? "Aktif" : state?.membership.leftAtBlock ? "Ayrildi" : "Uye degil"}</strong><p>{state?.membership.leftAtBlock ? `Cikis blogu: ${state.membership.leftAtBlock}` : ""}</p></article>
      <article className="owner-overview__metric card"><span className="eyebrow">CID OZETI</span><strong className="mono">{short(state?.vault.cidDigest ?? "")}</strong><p>Kayitli veri kasasinin zincirdeki ozetidir.</p></article>
      <article className="owner-overview__metric card"><span className="eyebrow">PANEL TAAHHUDU</span><strong className="mono">{state?.vault.commitment && state.vault.commitment !== "0" ? `${state.vault.commitment.slice(0, 12)}...` : "Kayit yok"}</strong><p>Panel geri cikarilamaz bir taahhut olarak tutulur.</p></article>
      <article className="owner-overview__metric card"><span className="eyebrow">KALICILIK</span><strong className="mono">{persistence?.tracked ? `${persistence.replicas} saglayici` : "Takip yok"}</strong><p>{persistence?.dueForRenewal ? "Yenileme gerekli." : ""}</p></article>
    </div>
    {active && <div className="card"><span className="eyebrow">HAVUZDAN AYRILMA</span><h2 style={{ marginTop: 8 }}>Gelecek sorgu paylarini durdur</h2><p className="card__body"><strong>Ayrilmak gecmisi silmez.</strong> Zaten homomorfik toplama karismis veriniz geri cekilemez; daha once hak ettiginiz oduller korunur. Ayrilma, bundan sonra acilacak sorgularda yeni pay olusmasini durdurur.</p><button className="pill pill--primary" style={{ marginTop: 16 }} disabled={busy} onClick={() => void leave()}>{busy ? "Islem gonderiliyor..." : "Havuzdan ayril"}</button></div>}
  </section>;
}
