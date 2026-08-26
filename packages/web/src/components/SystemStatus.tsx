import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider } from "ethers";

import { CONTRACTS, SEPOLIA_CHAIN_ID, explorerAddress } from "../config";
import { BIOMARKERS_ABI, PROTOCOL_ABI } from "../config/abi";
import {
  GENOMIC_PANEL,
  METRIC_PANEL,
  checkGenomicPanel,
  checkMetricPanel,
  ipfsHref,
  type PanelCheck,
} from "../lib/studyPanel";
import { decodeValue } from "../lib/metrics";
import { shorten } from "../lib/trace";

/**
 * Sistem durumu — dagitimin GERCEKTEN ne oldugunu zincirden okur.
 *
 * # Buradaki en onemli satir panel ozeti karsilastirmasi
 *
 * Tarayicidaki panel ile zincirin ilan ettigi ozet ayni degilse, kullanicinin
 * gonderdigi dozajlar baska bir varyant listesine ait olur ve kontenjans
 * tablosu alakasiz seyleri toplar. Tek kullaniciyla FARK EDILMEZ.
 *
 * Bu yuzden ozet burada yeniden hesaplanir ve uyusmazlik ekranda kirmizi
 * durur; sessizce gecistirilmez.
 *
 * Hicbir deger yer tutucu degildir: cuzdan yoksa herkese acik RPC uzerinden
 * okunur, o da olmazsa panel bos kalir ve sebebini soyler.
 */

const RPC_FALLBACK = "https://ethereum-sepolia-rpc.publicnode.com";

interface MetricRow {
  code: string;
  unit: string;
  scale: number;
  offset: number;
  minValue: number;
  maxValue: number;
}

interface SystemState {
  chainId: number;
  blockNumber: number;
  snpCount: number;
  rareSnpIndex: number;
  panelUri: string;
  metricsUri: string;
  metricCount: number;
  participantCount: number;
  minParticipants: number;
  biomarkerModule: string;
  moduleMatchesConfig: boolean;
  genomic: PanelCheck;
  metrics: PanelCheck;
  metricRows: MetricRow[];
}

/** `bytes32` icine sifir dolgulu ASCII etiketi geri okur. */
function decodeBytes32(value: string): string {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  let out = "";
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

function CheckBadge({ check, label }: { check: PanelCheck; label: string }) {
  if (check.unset) {
    return (
      <span className="badge badge--warn" title="Dagitim ozet verilmeden yapilmis">
        {label}: İLAN EDİLMEMİŞ
      </span>
    );
  }
  return check.matches ? (
    <span className="badge badge--ok">{label}: EŞLEŞTİ ✓</span>
  ) : (
    <span className="badge badge--fail">{label}: UYUŞMUYOR ✗</span>
  );
}

export function SystemStatus() {
  const [state, setState] = useState<SystemState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const read = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Cuzdan varsa onun saglayicisi, yoksa herkese acik RPC. Panelin
      // gorunmesi icin cuzdan SART DEGIL — zincir zaten herkese acik.
      const provider = window.ethereum
        ? new BrowserProvider(window.ethereum)
        : new JsonRpcProvider(RPC_FALLBACK);

      const network = await provider.getNetwork();
      const blockNumber = await provider.getBlockNumber();

      const protocol = new Contract(CONTRACTS.VeriarfyProtocol, PROTOCOL_ABI, provider);

      const [
        snpCount,
        rareSnpIndex,
        panelHash,
        panelUri,
        participantCount,
        minParticipants,
        biomarkerModule,
      ] = await Promise.all([
        protocol.snpCount(),
        protocol.rareSnpIndex(),
        protocol.panelHash(),
        protocol.panelUri(),
        protocol.participantCount(),
        protocol.minParticipants(),
        protocol.biomarkerModule(),
      ]);

      const genomic = await checkGenomicPanel(panelHash);

      // Modul adresi: ZINCIRDEN okunani esas al, yapilandirmayi ona karsi
      // dogrula. Ters yapilsaydi yanlis adrese sifreleme yapilir ve girdi
      // kaniti reddedilirdi — sebebi anlasilmayan bir revert.
      const moduleAddress: string = biomarkerModule;
      const biomarkers = new Contract(moduleAddress, BIOMARKERS_ABI, provider);

      const [metricCount, metricsHash, metricsUri] = await Promise.all([
        biomarkers.metricCount(),
        biomarkers.metricsHash(),
        biomarkers.metricsUri(),
      ]);

      const metricRows: MetricRow[] = [];
      for (let i = 0; i < Number(metricCount); i++) {
        const spec = await biomarkers.metricAt(i);
        metricRows.push({
          code: decodeBytes32(spec.code),
          unit: decodeBytes32(spec.unit),
          scale: Number(spec.scale),
          offset: Number(spec.offset),
          minValue: Number(spec.minValue),
          maxValue: Number(spec.maxValue),
        });
      }

      setState({
        chainId: Number(network.chainId),
        blockNumber,
        snpCount: Number(snpCount),
        rareSnpIndex: Number(rareSnpIndex),
        panelUri,
        metricsUri,
        metricCount: Number(metricCount),
        participantCount: Number(participantCount),
        minParticipants: Number(minParticipants),
        biomarkerModule: moduleAddress,
        moduleMatchesConfig:
          moduleAddress.toLowerCase() ===
          (CONTRACTS.VeriarfyBiomarkers ?? "").toLowerCase(),
        genomic,
        metrics: await checkMetricPanel(metricsHash),
        metricRows,
      });
    } catch (err: any) {
      setError(err?.shortMessage ?? err?.message ?? "Zincir okunamadi.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  return (
    <div className="card">
      <div className="card__head">
        <h3>Sistem durumu</h3>
        <button className="pill pill--ghost" onClick={() => void read()} disabled={loading}>
          {loading ? "okunuyor…" : "↻ zincirden oku"}
        </button>
      </div>

      {error && <div className="notice notice--warn">{error}</div>}

      {!state && !error && <p className="card__body">Zincir okunuyor…</p>}

      {state && (
        <>
          <div className="badges">
            <span
              className={
                state.chainId === SEPOLIA_CHAIN_ID ? "badge badge--ok" : "badge badge--warn"
              }
            >
              {state.chainId === SEPOLIA_CHAIN_ID ? "SEPOLIA" : `AĞ ${state.chainId}`} · blok{" "}
              {state.blockNumber.toLocaleString("tr")}
            </span>
            <CheckBadge check={state.genomic} label="Genomik panel" />
            <CheckBadge check={state.metrics} label="Metrik paneli" />
            {!state.moduleMatchesConfig && (
              <span className="badge badge--fail">MODÜL ADRESİ YAPILANDIRMADAN FARKLI</span>
            )}
          </div>

          {state.minParticipants < 10 && (
            <div className="notice notice--warn">
              k-anonimlik eşiği {state.minParticipants}. Duman testi için
              düşürülmüş; <strong>gerçek katılımcılarla yükseltilmelidir</strong> —
              düşük eşik, açılan grup toplamlarından tek bir kişinin verisinin
              geri çıkarılmasına izin verir.
            </div>
          )}

          {!state.genomic.matches && !state.genomic.unset && (
            <div className="notice notice--warn">
              Tarayıcıdaki panel ile zincirin ilan ettiği özet farklı. Bu haldeyken
              gönderilen dozajlar başka bir varyant listesine ait olur ve tablo
              alakasız şeyleri toplar. Katkı adımı bu yüzden kapalı.
            </div>
          )}

          <div className="kv">
            <div className="kv__row">
              <span className="eyebrow">PROTOKOL</span>
              <a
                className="mono trace__link"
                href={explorerAddress(CONTRACTS.VeriarfyProtocol)}
                target="_blank"
                rel="noreferrer noopener"
              >
                {shorten(CONTRACTS.VeriarfyProtocol, 10, 8)}
              </a>
            </div>
            <div className="kv__row">
              <span className="eyebrow">BİYOBELİRTEÇ MODÜLÜ</span>
              <a
                className="mono trace__link"
                href={explorerAddress(state.biomarkerModule)}
                target="_blank"
                rel="noreferrer noopener"
              >
                {shorten(state.biomarkerModule, 10, 8)}
              </a>
            </div>
            <div className="kv__row">
              <span className="eyebrow">GENOMİK PANEL</span>
              <span className="mono">
                {state.snpCount} varyant · nadirlik #{state.rareSnpIndex}
              </span>
            </div>
            <div className="kv__row">
              <span className="eyebrow">PANEL ÖZETİ (ZİNCİR)</span>
              <span className="mono" title={state.genomic.onchain}>
                {shorten(state.genomic.onchain, 10, 8)}
              </span>
            </div>
            <div className="kv__row">
              <span className="eyebrow">PANEL ÖZETİ (YEREL)</span>
              <span className="mono" title={state.genomic.local}>
                {shorten(state.genomic.local, 10, 8)}
              </span>
            </div>
            {state.panelUri && (
              <div className="kv__row">
                <span className="eyebrow">PANEL (IPFS)</span>
                <a
                  className="mono trace__link"
                  href={ipfsHref(state.panelUri)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {shorten(state.panelUri, 14, 8)}
                </a>
              </div>
            )}
            <div className="kv__row">
              <span className="eyebrow">METRİK PANELİ</span>
              <span className="mono">{state.metricCount} metrik</span>
            </div>
            {state.metricsUri && (
              <div className="kv__row">
                <span className="eyebrow">METRİK TANIMI (IPFS)</span>
                <a
                  className="mono trace__link"
                  href={ipfsHref(state.metricsUri)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {shorten(state.metricsUri, 14, 8)}
                </a>
              </div>
            )}
            <div className="kv__row">
              <span className="eyebrow">KATILIMCI</span>
              <span className="mono">
                {state.participantCount} katılımcı · açılım eşiği{" "}
                {state.minParticipants}
                {state.minParticipants < 10 && " ⚠"}
              </span>
            </div>
          </div>

          <div className="card__head" style={{ marginTop: 24 }}>
            <h3 style={{ fontSize: 16 }}>Zincirin zorladığı metrik sınırları</h3>
            <span className="eyebrow">ARALIK DIŞI = ELENİR</span>
          </div>

          <div className="table">
            <div className="table__head">
              <span>METRİK</span>
              <span>BİRİM</span>
              <span>GEÇERLİ ARALIK</span>
              <span>ÖLÇEK</span>
            </div>
            {state.metricRows.map((m) => {
              const spec = { ...m, code: m.code, unit: m.unit };
              const low = decodeValue(m.minValue, spec);
              const high = decodeValue(m.maxValue, spec);
              return (
                <div className="table__row" key={m.code}>
                  <span className="mono">{m.code}</span>
                  <span className="mono">{m.unit}</span>
                  <span className="mono">
                    {low.toLocaleString("tr")} – {high.toLocaleString("tr")}
                  </span>
                  <span className="mono">
                    ×{m.scale}
                    {m.offset > 0 && ` +${m.offset.toLocaleString("tr")}`}
                  </span>
                </div>
              );
            })}
          </div>

          <p className="card__body" style={{ marginTop: 16 }}>
            Bu tablo yerel bir dosyadan değil, sözleşmenin kendisinden okundu.
            Ölçek ve sınırlar zincirde durur çünkü eleme zincirde yapılıyor —
            ilan edilen sınır ile zorlanan sınır aynı şey olmak zorunda.
            {METRIC_PANEL.metrics.length !== state.metricCount &&
              " DİKKAT: paketlenmiş metrik sayısı zincirdekinden farklı."}
            {GENOMIC_PANEL.variants.length !== state.snpCount &&
              " DİKKAT: paketlenmiş varyant sayısı zincirdekinden farklı."}
          </p>
        </>
      )}
    </div>
  );
}
