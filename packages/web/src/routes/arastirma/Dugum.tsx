import { userError } from "../../lib/userError";
import { useCallback, useEffect, useState } from "react";
import { formatEther } from "ethers";

import { SEPOLIA_CHAIN_ID } from "../../config";
import { getProtocol, readNodeStake, stakeNode, type NodeStakeState } from "../../lib/protocol";
import { useSession } from "../../lib/session";

export function Dugum() {
  const { address, chainId, provider, signer } = useSession();
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [stake, setStake] = useState<NodeStakeState | null>(null);
  const [loading, setLoading] = useState(false);
  const [staking, setStaking] = useState(false);
  const [notice, setNotice] = useState<{ kind: "warn" | "ok" | "info"; text: string } | null>(null);
  const wrongNetwork = chainId !== null && chainId !== SEPOLIA_CHAIN_ID;

  const refresh = useCallback(async () => {
    if (!provider || !address || chainId !== SEPOLIA_CHAIN_ID) return;
    setLoading(true);
    setNotice(null);
    try {
      const isAuthorized = await getProtocol(provider).isAuthorizedNode(address);
      const nextStake = isAuthorized ? await readNodeStake(provider, address) : null;
      setAuthorized(isAuthorized);
      setStake(nextStake);
    } catch (error) {
      setAuthorized(null);
      setStake(null);
      setNotice({ kind: "warn", text: userError(error, "Dugum durumu zincirden okunamadi.") });
    } finally {
      setLoading(false);
    }
  }, [address, chainId, provider]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const topUp = useCallback(async () => {
    if (!signer || !stake || stake.banned || stake.shortfall === 0n) return;
    setStaking(true);
    setNotice({ kind: "info", text: "Dugum teminati zincire yatiriliyor..." });
    try {
      const amount = (stake.shortfall * 120n) / 100n;
      await stakeNode(signer, amount);
      await refresh();
      setNotice({ kind: "ok", text: "Teminat guncellendi; onay yeterliligi zincirden yeniden okundu." });
    } catch (error) {
      setNotice({ kind: "warn", text: userError(error, "Teminat yatirilamadi.") });
    } finally {
      setStaking(false);
    }
  }, [refresh, signer, stake]);

  return (
    <section className="node-panel" aria-labelledby="node-panel-title">
      <div className="node-panel__heading">
        <div>
          <span className="eyebrow">ARASTIRMACI / DUGUM</span>
          <h1 id="node-panel-title">Onay dugumunuzun ekonomik yeterliligi</h1>
          <p>Yetkili olmak tek basina yeterli degil: `minStake()` sorgu degeriyle buyur ve onay uygunlugu zincirden yeniden okunur.</p>
        </div>
        <button className="pill pill--ghost" disabled={loading || wrongNetwork} onClick={() => void refresh()}>{loading ? "Okunuyor..." : "Yenile"}</button>
      </div>

      {wrongNetwork && <div className="notice notice--warn">Dugum ve stake durumu yalnizca Sepolia aginda okunabilir.</div>}
      {notice && <div className={`notice notice--${notice.kind}`} role="status">{notice.text}</div>}

      <div className="node-panel__grid">
        <article className="node-panel__state card">
          <span className="eyebrow">YETKI DURUMU</span>
          <strong className="node-panel__status">{authorized === null ? "-" : authorized ? "Yetkili dugum" : "Yetkili degil"}</strong>
          <p>{authorized ? "Bu cuzdana onay yetkisi verilmis." : "Bu cuzdana protokol tarafindan onay yetkisi verilmemis."}</p>
        </article>
        <article className="node-panel__state card">
          <span className="eyebrow">GUNCEL minStake()</span>
          <strong className="node-panel__status mono">{stake ? `${formatEther(stake.required)} ETH` : "-"}</strong>
          <p>Gerekli teminat; gecmis toplam ucret buyudukce artabilir.</p>
        </article>
        <article className="node-panel__state card">
          <span className="eyebrow">ONAY VEREBILIR MI</span>
          <strong className="node-panel__status">{stake ? stake.banned ? "Yasakli" : stake.canApprove ? "Evet" : "Hayir" : "-"}</strong>
          <p>{stake?.banned ? "Yasakli dugum stake yatiramaz." : stake?.canApprove ? "Yetki ve teminat esigi saglaniyor." : "Teminat esigi saglanmadan onay islemi revert olur."}</p>
        </article>
      </div>

      {authorized && stake && (
        <aside className="node-panel__stake card card--bone">
          <div>
            <span className="eyebrow">TEMINAT</span>
            <h2>{formatEther(stake.staked)} ETH yatirilmis</h2>
            <p>{stake.shortfall === 0n ? "Guncel minStake esigi saglaniyor." : `${formatEther(stake.shortfall)} ETH eksik. Buton, esik yeniden artarsa hemen yetersiz kalmamak icin eksigin %120sini yatirir.`}</p>
          </div>
          {!stake.canApprove && !stake.banned && <button className="pill pill--primary" disabled={staking || !signer} onClick={() => void topUp()}>{staking ? "Yatiriliyor..." : `Teminati tamamla (${formatEther((stake.shortfall * 120n) / 100n)} ETH)`}</button>}
        </aside>
      )}
    </section>
  );
}
