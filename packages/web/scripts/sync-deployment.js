/**
 * Kontrat adreslerini tek kaynaktan kopyalar.
 *
 * NEDEN: `src/config/deployment.json`, `packages/contracts/deployments/sepolia.json`
 * dosyasinin elle tutulan bir ikiziydi. Iki dosya ayni gercegi anlattigi icin
 * biri guncellenip digeri unutuldugunda fark sessizce geciyor: uygulama derlenir,
 * testler gecer, ama arayuz artik var olmayan kontratlari okur ve kullaniciya
 * anlamsiz zincir hatalari doner. Bu tam olarak bir kez yasandi.
 *
 * Artik kopya her dev/build oncesi yeniden uretiliyor; elle duzenlenmiyor.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "contracts", "deployments", "sepolia.json");
const target = join(here, "..", "src", "config", "deployment.json");

if (!existsSync(source)) {
  // Kaynak yoksa mevcut kopya korunur: deploy dosyasi git-disi tutulan bir
  // kurulumda derlemeyi kirmamak icin. Sessiz kalmiyoruz ama durdurmuyoruz.
  console.warn(`sync-deployment: kaynak yok, mevcut kopya korunuyor (${source})`);
  process.exit(0);
}

const next = readFileSync(source, "utf8");
const current = existsSync(target) ? readFileSync(target, "utf8") : null;

if (current === next) {
  console.log("sync-deployment: adresler guncel.");
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, next);

const { contracts } = JSON.parse(next);
console.log(
  `sync-deployment: adresler guncellendi (Protocol ${contracts.VeriarfyProtocol}, ` +
    `Registry ${contracts.VeriArfyRegistry}).`,
);
