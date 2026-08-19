/**
 * Calismanin panelleri — paketlenmis kopya ve ZINCIRE KARSI dogrulama.
 *
 * # Neden paketleniyor
 *
 * Zincir panelin kendisini tutmaz, yalnizca OZETINI (`panelHash`,
 * `metricsHash`). Istemcinin hizalanacagi listeye ihtiyaci var; o liste
 * buradan gelir.
 *
 * # Neden bu tek basina yetmez
 *
 * Paketlenmis bir liste "dogru liste" oldugunu kendiliginden kanitlamaz.
 * Kanit, ozetin YENIDEN HESAPLANIP zincirdekiyle karsilastirilmasidir. Ikisi
 * ayrilmissa hizalama sessizce bozulur — MK-0013'un anlattigi hata tam olarak
 * budur — ve bu yuzden uyusmazlik ekranda ACIKCA gosterilir, yutulmaz.
 *
 * Dosyalar `packages/web/scripts/prepare-study.ts` tarafindan uretilir; elle
 * duzenlenen bir kopya ozetten sapardi.
 */
import genomicJson from "../config/study/genomic-panel.json";
import metricJson from "../config/study/metric-panel.json";

import { panelDigest, type StudyPanel } from "./panel";
import { metricsDigest, type MetricPanel } from "./metrics";

export const GENOMIC_PANEL = genomicJson as StudyPanel & { note?: string };
export const METRIC_PANEL = metricJson as MetricPanel & { note?: string };

export interface PanelCheck {
  /** Yerel panelden yeniden hesaplanan ozet. */
  local: string;
  /** Zincirin ilan ettigi ozet. */
  onchain: string;
  /** Ikisi ayni mi? */
  matches: boolean;
  /**
   * Zincirde ozet YOK (sifir) — dagitim `PANEL_HASH` verilmeden yapilmis.
   *
   * Ayri bir durum: "uyusmuyor" degil, "hic ilan edilmemis". Tek kullanicili
   * duman testinde sorun degil, gercek katilimcilarla ZORUNLUDUR.
   */
  unset: boolean;
}

const ZERO = `0x${"0".repeat(64)}`;

function compare(local: string, onchain: string): PanelCheck {
  return {
    local,
    onchain,
    matches: local.toLowerCase() === onchain.toLowerCase(),
    unset: !onchain || onchain === ZERO,
  };
}

/** Genomik panelin ozetini zincirdekiyle karsilastirir. */
export async function checkGenomicPanel(onchainHash: string): Promise<PanelCheck> {
  return compare(await panelDigest(GENOMIC_PANEL), onchainHash);
}

/** Metrik panelinin ozetini zincirdekiyle karsilastirir. */
export async function checkMetricPanel(onchainHash: string): Promise<PanelCheck> {
  return compare(await metricsDigest(METRIC_PANEL), onchainHash);
}

/** `ipfs://Qm…` -> herkese acik agecit baglantisi. */
export function ipfsHref(uri: string): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  if (uri.startsWith("http")) return uri;
  return undefined;
}
