/**
 * Zama relayer SDK'sinin wasm modullerini web'in servis ettigi klasore kopyalar.
 *
 * # Neden gerekli
 *
 * SDK kendi wasm'ini `new URL('tfhe_bg.wasm', import.meta.url)` ile bulmaya
 * calisir. Vite gelistirmede paketi on-derleyip `node_modules/.vite/deps/`
 * altina tasidigi icin bu adres yaninda wasm OLMAYAN bir klasore duser; dev
 * sunucusu da bulunamayan yola index.html dondurur.
 *
 * Sonuc, sebebi hic belli olmayan bir hatadir:
 *
 *     WebAssembly.instantiate(): expected magic word 00 61 73 6d,
 *                                found 3c 21 64 6f
 *
 * `3c 21 64 6f` = "<!do" — yani wasm sanilan sey aslinda HTML.
 *
 * # Neden `?url` ile ithal edilmiyor
 *
 * Paketin `exports` alani yalnizca `./web`, `./bundle`, `./node` yollarini
 * aciyor; `./lib/tfhe_bg.wasm` derin ithali engelleniyor. Bu yuzden dosyalar
 * kopyalanir ve SDK'ya ACIK yol verilir (`initSDK({ tfheParams, kmsParams })`)
 * — hem gelistirmede hem uretim derlemesinde ayni sekilde calisir.
 *
 * Ciktilar `public/fhe/` altinda ISLENIR: Vercel gibi bir ortamda derleme
 * sirasinda uretilebilseler de, islenmis olmalari dagitimi kaynaktan
 * bagimsiz kilar.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "public", "fhe");

// Paketin gercek yerini Node'un cozumleyicisine sordurur: monorepo'da paket
// koke de pakete de kurulmus olabilir, sabit bir yol yazmak kirilgan olurdu.
const require = createRequire(import.meta.url);
const sdkRoot = dirname(
  require.resolve("@zama-fhe/relayer-sdk/package.json"),
);
const LIB = join(sdkRoot, "lib");

const FILES = ["tfhe_bg.wasm", "kms_lib_bg.wasm"];

const missing = FILES.filter((name) => !existsSync(join(LIB, name)));
if (missing.length) {
  console.error(
    `Zama SDK wasm dosyalari bulunamadi: ${missing.join(", ")}\n` +
      `Aranan yer: ${LIB}\n` +
      "npm install calistirildi mi?",
  );
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
for (const name of FILES) {
  copyFileSync(join(LIB, name), join(OUT, name));
  console.log(`kopyalandi: public/fhe/${name}`);
}
