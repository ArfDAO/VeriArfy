import { useCallback, useEffect, useState } from "react";
import type { BrowserProvider, Signer } from "ethers";

import { CONTRACTS, SEPOLIA_CHAIN_ID } from "../config";
import {
  GROUP,
  enroll,
  readContributionState,
  type ContributionState,
} from "../lib/protocol";
import { checkGenomicPanel, checkMetricPanel } from "../lib/studyPanel";
import { connectWallet, ensureSepolia, hasWallet, shortAddress } from "../lib/wallet";
import { useTrace } from "../lib/useTrace";
import {
  addressEvidence,
  hashEvidence,
  noteEvidence,
  txEvidence,
  valueEvidence,
} from "../lib/trace";

import { GenomicStep } from "./GenomicStep";
import { BiomarkerStep } from "./BiomarkerStep";
import { TraceConsole } from "./TraceConsole";

/**
 * Katki akisi — uc adim, her adimda kanit.
 *
 * # Sirasi zorunlu, keyfi degil
 *
 *   1. KAYIT     sifreli grup etiketi yazilir. Modul de ayni etiketi
 *                kullanabilsin diye izin TAM BURADA verilir; sonradan
 *                verilemez.
 *   2. GENOMIK   dozajlar panele hizalanip partiler halinde gonderilir.
 *   3. OLCUM     surekli metrikler kodlanip gonderilir.
 *
 * Adim 1 olmadan 2 ve 3 revert eder (`NotEnrolled`): grup bilinmeden hangi
 * tabloya yazilacagi belli olmaz.
 *
 * # Panel ozeti tutmuyorsa akis KAPALI
 *
 * Tarayicidaki panel ile zincirin ilan ettigi ozet farkliysa gonderilen
 * dozajlar baska bir varyant listesine ait olur. Bu tek kullaniciyla fark
 * edilmez; ikinci kullanicida sessizce bozulur. Devam ettirmek yerine
 * durdurulur.
 */

export function Contribute() {
  const trace = useTrace();

  const [provider, setProvider] = useState<BrowserProvider | null>(null);
  const [signer, setSigner] = useState<Signer | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);

  const [state, setState] = useState<ContributionState | null>(null);
  const [panelOk, setPanelOk] = useState<boolean | null>(null);
  const [group, setGroup] = useState<number>(GROUP.CONTROL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Zincirden okur — her adimdan sonra cagrilir ki ekran gercegi gostersin. */
  const refresh = useCallback(
    async (p: BrowserProvider, who: string, quiet = false) => {
      const next = await readContributionState(p, who);
      setState(next);

      const [genomic, metrics] = await Promise.all([
        checkGenomicPanel(next.panelHash),
        checkMetricPanel(next.metricsHash),
      ]);
      setPanelOk(genomic.matches && metrics.matches);

      if (!quiet) {
        trace.begin("panel", "Panel özetleri zincire karşı doğrulandı");
        if (genomic.matches && metrics.matches) {
          trace.succeed(
            "panel",
            "Tarayıcıdaki paneller zincirin ilan ettiği özetlerle aynı",
            [
              hashEvidence("genomik panel özeti", genomic.onchain, true),
              hashEvidence("metrik paneli özeti", metrics.onchain, true),
              valueEvidence("panel boyutu", `${next.snpCount} varyant`, true),
              valueEvidence("metrik sayısı", next.metricCount, true),
              noteEvidence(
                "bu neden önemli",
                "özet tutmazsa iki kullanıcının «3 numaralı SNP»si farklı varyant olur ve tablo alakasız şeyleri toplar",
              ),
            ],
          );
        } else {
          trace.fail(
            "panel",
            new Error(
              genomic.unset || metrics.unset
                ? "Zincirde panel özeti ilan edilmemiş — dağıtım PANEL_HASH verilmeden yapılmış."
                : "Tarayıcıdaki panel ile zincirdeki özet farklı. Katkı akışı kapatıldı.",
            ),
          );
        }
      }

      return next;
    },
    [trace],
  );

  const connect = useCallback(async () => {
    setError(null);
    setBusy(true);
    trace.begin("wallet", "Cüzdan bağlandı");
    try {
      const { provider: p, address: who, chainId: id } = await connectWallet();
      if (id !== SEPOLIA_CHAIN_ID) {
        await ensureSepolia();
      }
      const s = await p.getSigner();

      setProvider(p);
      setSigner(s);
      setAddress(who);
      setChainId(id);

      const block = await p.getBlockNumber();
      trace.succeed("wallet", `${shortAddress(who)} · Sepolia`, [
        addressEvidence("cüzdan", who),
        addressEvidence("protokol", CONTRACTS.VeriarfyProtocol),
        valueEvidence("blok", block.toLocaleString("tr"), true),
      ]);

      await refresh(p, who);
    } catch (err) {
      trace.fail("wallet", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [trace, refresh]);

  const doEnroll = useCallback(async () => {
    if (!signer || !provider || !address) return;
    setBusy(true);
    setError(null);

    trace.begin("enroll", "Şifreli grup etiketi yazıldı");
    try {
      const outcome = await enroll(signer, group);

      trace.succeed(
        "enroll",
        `${group === GROUP.CASE ? "Vaka" : "Kontrol"} grubu — şifreli olarak`,
        [
          txEvidence("işlem", outcome.hash),
          valueEvidence("blok", outcome.blockNumber.toLocaleString("tr"), true),
          valueEvidence("gaz", Number(outcome.gasUsed).toLocaleString("tr"), true),
          noteEvidence("ciphertext handle", outcome.handles[0]),
          noteEvidence(
            "zincir grubu görüyor mu",
            "hayır — yalnızca şifreli handle saklanır, karşılaştırmalar homomorfik yapılır",
          ),
        ],
      );

      // Zincirden GERI OKU: "gonderdim" ile "zincir oyle diyor" ayni sey degil.
      trace.begin("enroll-verify", "Kayıt zincirden geri okundu");
      const next = await refresh(provider, address, true);
      if (next.isEnrolled) {
        trace.succeed("enroll-verify", "Sözleşme kaydı doğruluyor", [
          valueEvidence("isEnrolled", "true", true),
          valueEvidence("biyobelirteç modülü", next.biomarkerModule, true),
        ]);
      } else {
        trace.fail("enroll-verify", new Error("Zincir hâlâ kayıtsız görünüyor."));
      }
    } catch (err) {
      trace.fail("enroll", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [signer, provider, address, group, trace, refresh]);

  /** Adim bittikten sonra zincirden geri okuyup kaniti konsola yazar. */
  const verifyAfter = useCallback(
    async (id: string, label: string, read: (s: ContributionState) => [string, number, number]) => {
      if (!provider || !address) return;
      trace.begin(id, label);
      try {
        const next = await refresh(provider, address, true);
        const [name, got, want] = read(next);
        if (got >= want && want > 0) {
          trace.succeed(id, "Sözleşme sayacı bekleneni gösteriyor", [
            valueEvidence(name, `${got}/${want}`, true),
          ]);
        } else {
          trace.fail(id, new Error(`${name} = ${got}, beklenen ${want}`));
        }
      } catch (err) {
        trace.fail(id, err);
      }
    },
    [provider, address, trace, refresh],
  );

  useEffect(() => {
    if (!hasWallet()) return;
    // Otomatik baglanmiyoruz: cuzdan izni kullanicinin kararidir.
  }, []);

  const wrongChain = chainId !== null && chainId !== SEPOLIA_CHAIN_ID;
  const blocked = panelOk === false;

  return (
    <div className="contribute">
      <div className="contribute__flow">
        {/* --- Adim 0: cuzdan --- */}
        <div className="card">
          <div className="card__head">
            <h3>0 · Cüzdan</h3>
            {address && <span className="badge badge--ok">{shortAddress(address)}</span>}
          </div>

          {!hasWallet() ? (
            <div className="notice notice--warn">
              Ethereum cüzdanı bulunamadı. MetaMask kurulu bir tarayıcı gerekiyor.
            </div>
          ) : !address ? (
            <>
              <p className="card__body">
                Sepolia ağına bağlanın. Şifreleme tarayıcıda yapılır; özel
                anahtarınız hiçbir yere gitmez.
              </p>
              <button
                className="pill pill--primary"
                style={{ marginTop: 16 }}
                onClick={() => void connect()}
                disabled={busy}
              >
                {busy ? "bağlanıyor…" : "Cüzdanı bağla"}
              </button>
            </>
          ) : (
            <div className="kv">
              <div className="kv__row">
                <span className="eyebrow">AĞ</span>
                <span className="mono">
                  {wrongChain ? `YANLIŞ AĞ (${chainId})` : "Sepolia"}
                </span>
              </div>
              <div className="kv__row">
                <span className="eyebrow">KATILIMCI SAYISI</span>
                <span className="mono">{state?.participantCount ?? "—"}</span>
              </div>
            </div>
          )}
        </div>

        {blocked && (
          <div className="notice notice--warn">
            Panel özeti tutmuyor. Katkı akışı bilerek kapatıldı — bu haldeyken
            gönderilen veriler başka bir varyant listesine ait olur ve tablo
            sessizce bozulur.
          </div>
        )}

        {/* --- Adim 1: kayit --- */}
        {address && state && (
          <div className="card">
            <div className="card__head">
              <h3>1 · Gruba kayıt</h3>
              <span className={state.isEnrolled ? "badge badge--ok" : "eyebrow"}>
                {state.isEnrolled ? "KAYITLI" : "GEREKLİ"}
              </span>
            </div>

            {state.isEnrolled ? (
              <p className="card__body">
                Şifreli grup etiketiniz zincirde. Bir kez yazılır ve tüm
                partilerde yeniden kullanılır — partiler arasında grup
                değiştirip tabloyu bozmak mümkün değil.
              </p>
            ) : (
              <>
                <p className="card__body">
                  Çalışmanın vaka/kontrol grubundan hangisindesiniz? Bu değer
                  şifreli gider; sözleşme hangisini seçtiğinizi göremez.
                </p>
                <div className="row" style={{ marginTop: 16 }}>
                  <select
                    className="select"
                    value={group}
                    onChange={(e) => setGroup(Number(e.target.value))}
                    disabled={busy || blocked}
                  >
                    <option value={GROUP.CONTROL}>Kontrol (sağlıklı)</option>
                    <option value={GROUP.CASE}>Vaka (hasta)</option>
                  </select>
                  <button
                    className="pill pill--primary"
                    onClick={() => void doEnroll()}
                    disabled={busy || blocked || wrongChain}
                  >
                    {busy ? "yazılıyor…" : "Şifrele ve kaydol"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* --- Adim 2: genomik --- */}
        {address && state && (
          <GenomicStep
            signer={signer}
            trace={trace}
            submitted={state.submittedSnps}
            snpCount={state.snpCount}
            disabled={!state.isEnrolled || blocked || wrongChain || busy}
            onDone={() =>
              void verifyAfter("dosages-verify", "Dozajlar zincirden geri okundu", (s) => [
                "submittedSnps",
                s.submittedSnps,
                s.snpCount,
              ])
            }
          />
        )}

        {/* --- Adim 3: biyobelirtec --- */}
        {address && state && state.metricCount > 0 && (
          <BiomarkerStep
            signer={signer}
            moduleAddress={state.biomarkerModule}
            trace={trace}
            submitted={state.submittedMetrics}
            metricCount={state.metricCount}
            disabled={!state.isEnrolled || blocked || wrongChain || busy}
            onDone={() =>
              void verifyAfter("biomarkers-verify", "Ölçümler zincirden geri okundu", (s) => [
                "submittedMetrics",
                s.submittedMetrics,
                s.metricCount,
              ])
            }
          />
        )}

        {error && <div className="notice notice--warn">{error}</div>}
      </div>

      <div className="contribute__trace">
        <TraceConsole steps={trace.steps} />
      </div>
    </div>
  );
}
