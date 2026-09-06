/**
 * Calisma tanimlarini dagitima hazirlar: ozetleri hesaplar, IPFS'e sabitler.
 *
 * # Neden ayri bir adim
 *
 * Zincir panelin KENDISINI tutmaz, yalnizca OZETINI. Ozet ile panelin
 * birbirinden ayrilmamasi icin ikisi tek yerde uretilmelidir: burada. Elle
 * hesaplanmis bir ozet gercek panelden sessizce sapabilirdi — MK-0013'un
 * anlattigi hatanin ta kendisi.
 *
 * # Neden `packages/web` icinde
 *
 * Ozet algoritmasi tarayicidakiyle BIREBIR AYNI olmak zorunda: istemci kendi
 * panelini `src/lib/panel.ts` ile dogrular, farkli hesaplansaydi dogrulama
 * her zaman basarisiz olurdu. Bu yuzden fonksiyonlar kopyalanmaz, dogrudan
 * ithal edilir — ve ithal edebilmek icin betigin ayni ESM paketinde olmasi
 * gerekir (hardhat betikleri CommonJS'tir).
 *
 * Calistirma:  node scripts/prepare-study.ts
 * Cikti     :  packages/contracts/study/{deploy-env,metrics-onchain}.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeBytes32String, keccak256, toUtf8Bytes } from "ethers";

import { panelDigest, type StudyPanel } from "../src/lib/panel.ts";
import { metricsDigest, type MetricPanel } from "../src/lib/metrics.ts";

const WEB_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** Panellerin tarayiciya paketlenen kopyasi — istemci ozeti buradan dogrular. */
const WEB_STUDY_DIR = join(WEB_DIR, "src", "config", "study");

const STUDY_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "contracts",
  "study",
);

/** Pinata'ya JSON sabitler; JWT yoksa `null` doner (dagitim yine calisir). */
async function pinJson(name: string, body: unknown): Promise<string | null> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) return null;

  const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ pinataMetadata: { name }, pinataContent: body }),
  });

  if (!response.ok) {
    console.log(`  UYARI: Pinata ${response.status} — ${name} sabitlenemedi.`);
    return null;
  }

  const { IpfsHash } = (await response.json()) as { IpfsHash: string };
  return `ipfs://${IpfsHash}`;
}

async function main() {
  console.log("Calisma tanimlari hazirlaniyor\n");

  // --- Genomik panel ------------------------------------------------------
  const genomic = JSON.parse(
    readFileSync(join(STUDY_DIR, "genomic-panel.json"), "utf8"),
  ) as StudyPanel;

  const panelHash = await panelDigest(genomic);
  const panelUri = (await pinJson("veriarfy-genomic-panel", genomic)) ?? "";

  console.log(`Genomik panel : ${genomic.variants.length} varyant`);
  console.log(`  ozet        : ${panelHash}`);
  console.log(`  IPFS        : ${panelUri || "(sabitlenmedi — PINATA_JWT yok)"}`);

  // --- Metrik paneli ------------------------------------------------------
  const metricDoc = JSON.parse(
    readFileSync(join(STUDY_DIR, "metric-panel.json"), "utf8"),
  ) as MetricPanel;

  const metricsHash = await metricsDigest(metricDoc);
  const metricsUri = (await pinJson("veriarfy-metric-panel", metricDoc)) ?? "";

  console.log(`\nMetrik paneli : ${metricDoc.metrics.length} metrik`);
  console.log(`  ozet        : ${metricsHash}`);
  console.log(`  IPFS        : ${metricsUri || "(sabitlenmedi — PINATA_JWT yok)"}`);

  // --- Zincire gidecek metrik dizisi --------------------------------------
  //
  // `code` ve `unit` zincirde `bytes32`. 31 bayti asan bir etiket sessizce
  // kirpilirdi — panelde bir sey, zincirde baskasi. Acikca reddedilir.
  const onchainMetrics = metricDoc.metrics.map((m) => {
    for (const [field, value] of [
      ["code", m.code],
      ["unit", m.unit],
    ] as const) {
      if (Buffer.byteLength(value, "utf8") > 31) {
        throw new Error(`${m.code}: '${field}' 31 bayti asiyor — bytes32'ye sigmaz.`);
      }
    }
    return {
      code: encodeBytes32String(m.code),
      unit: encodeBytes32String(m.unit),
      scale: m.scale,
      offset: m.offset,
      minValue: m.minValue,
      maxValue: m.maxValue,
    };
  });
  const metricsSpecDigest = keccak256(toUtf8Bytes(JSON.stringify(onchainMetrics)));

  writeFileSync(
    join(STUDY_DIR, "metrics-onchain.json"),
    `${JSON.stringify(onchainMetrics, null, 2)}\n`,
  );

  const env = {
    PANEL_HASH: panelHash,
    PANEL_URI: panelUri,
    SNP_COUNT: genomic.variants.length,
    METRICS_HASH: metricsHash,
    METRICS_SPEC_HASH: metricsSpecDigest,
    METRICS_URI: metricsUri,
    // deploy-env baska checkout'ta da calisabilsin; deploy betigi bu yolu
    // deploy-env.json'in bulundugu study dizinine gore cozer.
    METRICS_FILE: "metrics-onchain.json",
    preparedAt: new Date().toISOString(),
  };

  writeFileSync(join(STUDY_DIR, "deploy-env.json"), `${JSON.stringify(env, null, 2)}\n`);
  console.log("\ncontracts/study/deploy-env.json yazildi.");

  // --- Tarayiciya paketlenen kopya ----------------------------------------
  //
  // Istemci paneli ZINCIRDEN okuyamaz (zincirde yalnizca ozeti var). Panelin
  // kendisi buradan paketlenir ve istemci ozeti yeniden hesaplayip zincirdekine
  // karsi dogrular — "dogru listeye hizaliyor muyum" sorusunun yaniti budur.
  //
  // Kopya OTOMATIK uretilir; elle duzenlenen bir kopya ozetten sapardi.
  mkdirSync(WEB_STUDY_DIR, { recursive: true });
  writeFileSync(
    join(WEB_STUDY_DIR, "genomic-panel.json"),
    `${JSON.stringify(genomic, null, 2)}\n`,
  );
  writeFileSync(
    join(WEB_STUDY_DIR, "metric-panel.json"),
    `${JSON.stringify(metricDoc, null, 2)}\n`,
  );
  console.log("web/src/config/study/ guncellendi (panel kopyalari).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
