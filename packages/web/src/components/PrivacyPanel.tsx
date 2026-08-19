import { useCallback, useEffect, useState } from "react";
import type { BrowserProvider } from "ethers";

import { CONTRACTS, explorerAddress, isProtocolDeployed } from "../config";
import {
  QUERY_TYPE,
  claimReward,
  confirmRarity,
  describeQueryTypes,
  formatToken,
  grantAccess,
  rarityMultiplierBps,
  readDashboard,
  readPersistence,
  readRarity,
  requestRarityAssessment,
  revokeAccess,
  type DashboardState,
  type PersistenceState,
  type RarityState,
} from "../lib/protocol";
import { publicDecryptRaw } from "../lib/fhe";
import { connectWallet, ensureSepolia, hasWallet } from "../lib/wallet";

/**
 * Gizlilik Paneli — rapor §3.4.
 *
 * Gosterilen her sayi zincirden okunur. Ornek veri, yer tutucu ya da
 * simulasyon YOKTUR: kontratlar deploy edilmemisse ya da cuzdan bagli
 * degilse panel bunu acikca soyler ve bos kalir.
 */

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** 32 baytlik digest'i okunabilir kisaltmaya cevirir. */
const shortHash = (hex: string) =>
  hex && hex !== `0x${"0".repeat(64)}` ? `${hex.slice(0, 10)}…${hex.slice(-6)}` : "—";

export function PrivacyPanel() {
  const [provider, setProvider] = useState<BrowserProvider | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [state, setState] = useState<DashboardState | null>(null);
  const [rarity, setRarity] = useState<RarityState | null>(null);
  const [persistence, setPersistence] = useState<PersistenceState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [grantTo, setGrantTo] = useState("");
  const [grantTypes, setGrantTypes] = useState<number>(
    QUERY_TYPE.GWAS | QUERY_TYPE.ML | QUERY_TYPE.STATISTICS,
  );

  const refresh = useCallback(
    async (p: BrowserProvider, who: string) => {
      setLoading(true);
      setError(null);
      try {
        const [dashboard, rarityState] = await Promise.all([
          readDashboard(p, who),
          readRarity(p, who),
        ]);
        setState(dashboard);
        setRarity(rarityState);
        setPersistence(await readPersistence(p, dashboard.vault.cidDigest));
      } catch (err: any) {
        setError(err?.shortMessage ?? err?.message ?? "Zincirden okunamadi.");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const connect = useCallback(async () => {
    setError(null);
    try {
      await ensureSepolia();
      const { provider: p, address: who } = await connectWallet();
      setProvider(p);
      setAddress(who);
      await refresh(p, who);
    } catch (err: any) {
      setError(err?.shortMessage ?? err?.message ?? "Cuzdan baglanamadi.");
    }
  }, [refresh]);

  // Cuzdan hesap degistirirse panel yeni hesaba gecmeli.
  useEffect(() => {
    if (!window.ethereum?.on) return;
    const onAccounts = (accounts: string[]) => {
      if (accounts.length === 0) {
        setAddress(null);
        setState(null);
      } else if (provider) {
        setAddress(accounts[0]);
        void refresh(provider, accounts[0]);
      }
    };
    window.ethereum.on("accountsChanged", onAccounts);
    return () => window.ethereum?.removeListener?.("accountsChanged", onAccounts);
  }, [provider, refresh]);

  const run = useCallback(
    async (label: string, action: () => Promise<unknown>) => {
      if (!provider || !address) return;
      setBusy(label);
      setError(null);
      setNotice(null);
      try {
        await action();
        setNotice(`${label} tamamlandi.`);
        await refresh(provider, address);
      } catch (err: any) {
        setError(err?.shortMessage ?? err?.reason ?? err?.message ?? `${label} basarisiz.`);
      } finally {
        setBusy(null);
      }
    },
    [provider, address, refresh],
  );

  /**
   * Esikli cozumu tamamlar: relayer'dan duz biti ve KMS imzalarini alir,
   * ikisini birlikte zincire yazar.
   *
   * Imzalar zincirde dogrulandigi icin bu adimi KIM yaptigi onemli degildir —
   * uydurulmus bir sonuc kabul edilmez.
   */
  const runRarityDecrypt = useCallback(async () => {
    if (!rarity || !address) return;
    await run("Esikli cozum", async () => {
      const result = await publicDecryptRaw([rarity.handle]);
      const signer = await provider!.getSigner();
      await confirmRarity(
        signer,
        address,
        result.abiEncodedClearValues,
        result.decryptionProof,
      );
    });
  }, [rarity, address, provider, run]);

  if (!isProtocolDeployed) {
    return (
      <div className="notice notice--warn">
        Protokol kontratlari henuz dagitilmamis. <code>npm run contracts:deploy:sepolia</code>
        {" "}calistirin.
      </div>
    );
  }

  if (!hasWallet()) {
    return (
      <div className="notice notice--warn">
        Bir Ethereum cuzdani bulunamadi. Panel zincirden okuma yaptigi icin cuzdan gerekli.
      </div>
    );
  }

  if (!address) {
    return (
      <div className="card card--bone" style={{ textAlign: "center", padding: 40 }}>
        <p style={{ marginBottom: 20, color: "var(--color-smoke)" }}>
          Verilerinizi, izinlerinizi ve kazancinizi gormek icin cuzdaninizi baglayin.
        </p>
        <button className="pill pill--primary" onClick={connect}>
          Cuzdani bagla
        </button>
        {error && <div className="notice notice--warn" style={{ marginTop: 16 }}>{error}</div>}
      </div>
    );
  }

  const decimals = state?.token.decimals ?? 6;
  const symbol = state?.token.symbol ?? "";

  return (
    <div style={{ display: "grid", gap: 20 }}>
      {error && <div className="notice notice--warn">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {/* --- Ozet -------------------------------------------------------- */}
      <div className="card card--bone">
        <div className="card__row">
          <span className="eyebrow">CUZDAN</span>
          <a
            className="mono"
            href={explorerAddress(address)}
            target="_blank"
            rel="noreferrer"
          >
            {short(address)}
          </a>
        </div>
        <div className="card__row">
          <span className="eyebrow">BEKLEYEN KAZANC</span>
          <span className="mono">
            {state ? formatToken(state.pendingTotal, decimals, symbol) : "…"}
          </span>
        </div>
        <div className="card__row">
          <span className="eyebrow">CUZDAN BAKIYESI</span>
          <span className="mono">
            {state ? formatToken(state.token.balance, decimals, symbol) : "…"}
          </span>
        </div>
        <div className="card__row">
          <span className="eyebrow">HAVUZDAKI KATILIMCI</span>
          <span className="mono">
            {state ? `${state.poolParticipants} (k-anonimlik esigi ${state.minParticipants})` : "…"}
          </span>
        </div>
        <button
          className="pill pill--ghost"
          style={{ marginTop: 12 }}
          disabled={loading}
          onClick={() => provider && refresh(provider, address)}
        >
          {loading ? "Okunuyor…" : "Yenile"}
        </button>
      </div>

      {/* --- Veri Kasasi ------------------------------------------------- */}
      <div className="card">
        <h3 style={{ marginBottom: 12 }}>Veri Kasasi</h3>
        {state?.vault.participantIndex === 0 && !state?.vault.cidDigest ? (
          <p style={{ color: "var(--color-smoke)", fontSize: 14 }}>
            Bu cuzdanla henuz veri yuklenmemis.
          </p>
        ) : (
          <>
            <div className="card__row">
              <span className="eyebrow">IPFS CID OZETI</span>
              <span className="mono" style={{ fontSize: 12 }}>
                {shortHash(state?.vault.cidDigest ?? "")}
              </span>
            </div>
            <div className="card__row">
              <span className="eyebrow">PANEL TAAHHUDU</span>
              <span className="mono" style={{ fontSize: 12 }}>
                {state && state.vault.commitment !== "0"
                  ? `${state.vault.commitment.slice(0, 12)}…`
                  : "—"}
              </span>
            </div>
            <div className="card__row">
              <span className="eyebrow">SIFRELI DOZAJ HAVUZDA</span>
              <span className="mono">{state?.vault.hasAggregated ? "Evet" : "Hayir"}</span>
            </div>
            <div className="card__row">
              <span className="eyebrow">KALICILIK (FILECOIN)</span>
              <span className="mono">
                {!persistence?.tracked
                  ? "IPFS pinli — Filecoin anlasmasi yok"
                  : `${persistence.replicas} saglayici${
                      persistence.adequate ? "" : " (esik alti)"
                    }${persistence.dueForRenewal ? " · yenileme gerekli" : ""}`}
              </span>
            </div>
            {persistence?.tracked && (
              /*
               * Iddianin KAYNAGINI gizlememek onemli: replika sayisi
               * zincirde zorlanan bir olgu degil, bir tanigin beyanidir
               * (bkz. MK-0010). Kullaniciya "3 saglayici" deyip bunun nereden
               * geldigini soylememek, olmayan bir kesinlik satmak olurdu.
               */
              <p style={{ fontSize: 12, color: "var(--color-smoke)", marginTop: 8 }}>
                Bu sayı bir <strong>tanık beyanıdır</strong>; anlaşmalar Filecoin
                zincirinde yaşar ve Ethereum onları doğrudan göremez. Kayıtlar
                anlaşma kimliğiyle birlikte tutulur, böylece Filecoin'in herkese
                açık RPC'sinden <em>bağımsız olarak</em> doğrulanabilir — bu
                denetim günlük olarak otomatik koşar.
              </p>
            )}
            <p style={{ fontSize: 12, color: "var(--color-smoke)", marginTop: 12 }}>
              Panelinizin kendisi zincire hic yazilmaz. Taahhut tek yonludur; salt
              bilinmedikce panel geri cikarilamaz.
            </p>
          </>
        )}
      </div>

      {/* --- Nadirlik Carpani (rapor §4.3) -------------------------------- */}
      <div className="card">
        <h3 style={{ marginBottom: 4 }}>Nadirlik Carpani</h3>
        <p style={{ fontSize: 13, color: "var(--color-smoke)", marginBottom: 16 }}>
          Nadir bir varyant tasiyorsaniz veriniz daha degerlidir ve payiniz{" "}
          <strong>R = log₂(1 + havuz / tasiyici)</strong> kati olur. Bunu olcmek
          icin genomunuz <em>acilmaz</em>: yalnizca “nadir mi?” sorusunun{" "}
          <strong>tek bitlik</strong> sifreli yaniti, KMS dugumlerinin esikli
          onayiyla cozulur.
        </p>

        {!state?.vault.hasAggregated ? (
          <p style={{ color: "var(--color-smoke)", fontSize: 14 }}>
            Once sifreli dozajinizi havuza gonderin.
          </p>
        ) : !rarity ? (
          <p style={{ color: "var(--color-smoke)", fontSize: 14 }}>Okunuyor…</p>
        ) : (
          <>
            <div className="card__row">
              <span className="eyebrow">DURUM</span>
              <span className="mono">
                {rarity.confirmed
                  ? rarity.isCarrier
                    ? "NADIR TASIYICI"
                    : "YAYGIN VARYANT"
                  : rarity.requested
                    ? "ESIKLI COZUM BEKLENIYOR"
                    : "DEGERLENDIRILMEDI"}
              </span>
            </div>
            <div className="card__row">
              <span className="eyebrow">HAVUZ / TASIYICI</span>
              <span className="mono">
                {rarity.poolCount} / {rarity.carriers}
              </span>
            </div>
            <div className="card__row">
              <span className="eyebrow">GUNCEL CARPAN</span>
              <span className="mono">
                {rarity.carriers > 0
                  ? `${(rarityMultiplierBps(rarity.poolCount, rarity.carriers) / 10_000).toFixed(2)}×`
                  : "—"}
              </span>
            </div>
            <div className="card__row">
              <span className="eyebrow">KURUCU KATKICI (+%50)</span>
              <span className="mono">{rarity.isFounding ? "Evet" : "Hayir"}</span>
            </div>

            {!rarity.confirmed && (
              <>
                <div
                  className="notice notice--warn"
                  style={{ marginTop: 16, fontSize: 13 }}
                >
                  <strong>Bunu bilerek secin.</strong> Degerlendirme sonucu
                  zincire yazilir ve herkese aciktir: bu adresin nadir varyant
                  tasiyip tasimadigi gorunur olur. Bu kacinilmazdir — yuksek pay
                  alan bir adresin tasiyici oldugu zaten odemeden anlasilir.
                  Acilan sey <strong>yalnizca bu tek bittir</strong>; dozajiniz,
                  paneliniz ve genomunuz kapali kalir. Degerlendirme
                  istemezseniz carpaniniz 1,00× olarak surer.
                </div>

                <button
                  className="btn"
                  style={{ marginTop: 12 }}
                  disabled={busy !== null}
                  onClick={() =>
                    rarity.requested
                      ? void runRarityDecrypt()
                      : void run("Nadirlik degerlendirmesi", async () =>
                          requestRarityAssessment(await provider!.getSigner()),
                        )
                  }
                >
                  {busy
                    ? "Islem suruyor…"
                    : rarity.requested
                      ? "Esikli cozumu tamamla"
                      : "Nadirlik degerlendirmesini baslat"}
                </button>
              </>
            )}
          </>
        )}
      </div>

      {/* --- Izinler ----------------------------------------------------- */}
      <div className="card">
        <h3 style={{ marginBottom: 4 }}>Erisim Izinleri</h3>
        <p style={{ fontSize: 13, color: "var(--color-smoke)", marginBottom: 16 }}>
          Veriniz yalnizca izin verdiginiz kurumlarca kullanilir. Izni geri
          aldiginizda, bundan <strong>sonra</strong> acilacak sorgular sizi kapsamaz;
          daha once hak ettiginiz paylar durur.
        </p>

        {state?.permissions.length === 0 && (
          <p style={{ color: "var(--color-smoke)", fontSize: 14, marginBottom: 16 }}>
            Henuz kimseye izin verilmemis.
          </p>
        )}

        {state?.permissions.map((p) => {
          const live =
            p.isAllowed &&
            (p.expirationBlock === 0n || p.expirationBlock > BigInt(p.grantedAtBlock));
          return (
            <div
              key={p.researcher}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                padding: "12px 0",
                borderTop: "1px solid rgba(0,0,0,0.06)",
              }}
            >
              <div>
                <div className="mono" style={{ fontSize: 13 }}>{short(p.researcher)}</div>
                <div style={{ fontSize: 12, color: "var(--color-smoke)" }}>
                  {describeQueryTypes(p.queryTypes).join(" · ") || "—"}
                  {p.expirationBlock > 0n && ` · blok ${p.expirationBlock} sonuna kadar`}
                </div>
              </div>
              {live ? (
                <button
                  className="pill pill--ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    run("Izin iptali", async () => {
                      const signer = await provider!.getSigner();
                      await revokeAccess(signer, p.researcher);
                    })
                  }
                >
                  {busy === "Izin iptali" ? "…" : "Izni geri al"}
                </button>
              ) : (
                <span className="eyebrow" style={{ color: "var(--color-smoke)" }}>
                  IPTAL EDILDI
                </span>
              )}
            </div>
          );
        })}

        {/* Yeni izin */}
        <div style={{ borderTop: "1px solid rgba(0,0,0,0.06)", paddingTop: 16, marginTop: 8 }}>
          <label className="eyebrow" style={{ display: "block", marginBottom: 8 }}>
            YENI IZIN VER
          </label>
          <input
            className="input"
            placeholder="Arastirmaci cuzdan adresi (0x…)"
            value={grantTo}
            onChange={(e) => setGrantTo(e.target.value.trim())}
            style={{ width: "100%", marginBottom: 10 }}
          />
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            {Object.entries(QUERY_TYPE).map(([name, bit]) => (
              <label key={name} style={{ fontSize: 13, display: "flex", gap: 6 }}>
                <input
                  type="checkbox"
                  checked={(grantTypes & bit) !== 0}
                  onChange={(e) =>
                    setGrantTypes((prev) => (e.target.checked ? prev | bit : prev & ~bit))
                  }
                />
                {describeQueryTypes(bit)[0]}
              </label>
            ))}
          </div>
          <button
            className="pill pill--primary"
            disabled={busy !== null || !grantTo || grantTypes === 0}
            onClick={() =>
              run("Izin verme", async () => {
                const signer = await provider!.getSigner();
                await grantAccess(signer, grantTo, grantTypes);
                setGrantTo("");
              })
            }
          >
            {busy === "Izin verme" ? "Gonderiliyor…" : "Izin ver"}
          </button>
        </div>
      </div>

      {/* --- Sorgular ve kazanc ------------------------------------------ */}
      <div className="card">
        <h3 style={{ marginBottom: 4 }}>Sorgular ve Kazanc</h3>
        <p style={{ fontSize: 13, color: "var(--color-smoke)", marginBottom: 16 }}>
          Verinizin kullanildigi her sorgudan pay alirsiniz. Odeme, sorgu
          ucretinin %80'inin izin veren katilimcilara bolunmesiyle hesaplanir.
        </p>

        {state?.queries.length === 0 && (
          <p style={{ color: "var(--color-smoke)", fontSize: 14 }}>
            Henuz sorgu acilmamis.
          </p>
        )}

        {state?.queries.map((q) => (
          <div
            key={q.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              padding: "12px 0",
              borderTop: "1px solid rgba(0,0,0,0.06)",
            }}
          >
            <div>
              <div style={{ fontSize: 13 }}>
                Sorgu #{q.id} · {short(q.researcher)}
              </div>
              <div style={{ fontSize: 12, color: "var(--color-smoke)" }}>
                {q.snapshotCount} katilimci · blok {q.openedAtBlock} ·{" "}
                {formatToken(q.fee, decimals, symbol)}
              </div>
            </div>
            {q.refunded ? (
              <span className="eyebrow" style={{ color: "var(--color-smoke)" }}>IADE EDILDI</span>
            ) : !q.settled ? (
              // Rapor §2.6: ucret, yetkili kurumlarin onayi gelene kadar
              // emanette bekler. Bu asamada kimse pay cekemez.
              <span className="eyebrow" style={{ color: "var(--color-smoke)" }}>
                BSKK-44 ONAYI BEKLENIYOR
              </span>
            ) : q.claimed ? (
              <span className="eyebrow" style={{ color: "var(--color-smoke)" }}>ÇEKILDI</span>
            ) : q.claimable > 0n ? (
              <button
                className="pill pill--primary"
                disabled={busy !== null}
                onClick={() =>
                  run(`Pay cekme #${q.id}`, async () => {
                    const signer = await provider!.getSigner();
                    await claimReward(signer, q.id);
                  })
                }
              >
                {busy === `Pay cekme #${q.id}`
                  ? "…"
                  : `${formatToken(q.claimable, decimals, symbol)} cek`}
              </button>
            ) : (
              <span className="eyebrow" style={{ color: "var(--color-smoke)" }}>
                KAPSAM DISI
              </span>
            )}
          </div>
        ))}
      </div>

      <p style={{ fontSize: 12, color: "var(--color-smoke)", textAlign: "center" }}>
        Protokol:{" "}
        <a href={explorerAddress(CONTRACTS.VeriarfyProtocol)} target="_blank" rel="noreferrer">
          {short(CONTRACTS.VeriarfyProtocol)}
        </a>
        {" · "}Odemeler:{" "}
        <a href={explorerAddress(CONTRACTS.VeriarfyPayments)} target="_blank" rel="noreferrer">
          {short(CONTRACTS.VeriarfyPayments)}
        </a>
      </p>
    </div>
  );
}
