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
const deployments = join(here, "..", "..", "contracts", "deployments");
const config = join(here, "..", "src", "config");

/** [kaynak dosya, hedef dosya, zorunlu mu] */
const FILES = [
  ["sepolia.json", "deployment.json", true],
  // E/19 klinik yigini ayri bir dagitim. Arayuz bunu OKUMAK zorunda: onam
  // ekrani daha once "DEPLOY EDILMEDI" diye SABIT YAZILMIS bir rozet
  // tasiyordu ve E/19 gercekten dagitildiktan sonra da oyle kaldi. Yani
  // sayfa var olan bir sistemi yok gosteriyordu. Bir kez yazilip bir daha
  // bakilmayan durum metinleri hep boyle bozulur; durum artik kaynaktan gelir.
  ["e19-sepolia.json", "e19-deployment.json", false],
];

let changed = 0;

for (const [sourceName, targetName, required] of FILES) {
  const source = join(deployments, sourceName);
  const target = join(config, targetName);

  if (!existsSync(source)) {
    // Kaynak yoksa mevcut kopya korunur: deploy dosyasi git-disi tutulan bir
    // kurulumda derlemeyi kirmamak icin. Sessiz kalmiyoruz ama durdurmuyoruz.
    if (required) {
      console.warn(`sync-deployment: kaynak yok, mevcut kopya korunuyor (${source})`);
    }
    continue;
  }

  const next = readFileSync(source, "utf8");
  const current = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (current === next) continue;

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, next);
  changed += 1;
  console.log(`sync-deployment: ${targetName} guncellendi.`);
}

if (changed === 0) console.log("sync-deployment: adresler guncel.");
