/**
 * Devre ciktilarini web'in servis ettigi klasore kopyalar.
 *
 * Bu dosyalar (wasm ~1.7MB, zkey ~5MB) uretilebilir oldugu icin depoda
 * tutulmaz; `npm run circuits:build` sonrasi buradan kopyalanir.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILD = join(__dirname, "..", "..", "circuits", "build");
const OUT = join(__dirname, "..", "public", "circuits");

const FILES = [
  [join(BUILD, "researcher_identity_js", "researcher_identity.wasm"), "researcher_identity.wasm"],
  [join(BUILD, "researcher_identity_final.zkey"), "researcher_identity_final.zkey"],
  // Veri kokeni — katki akisinda kullanilir. Kapsama bitleri bu devrenin
  // ACIK CIKTISIDIR, dolayisiyla odemenin dayanagi da buradan gelir.
  [join(BUILD, "data_provenance_js", "data_provenance.wasm"), "data_provenance.wasm"],
  [join(BUILD, "data_provenance_final.zkey"), "data_provenance_final.zkey"],
];

const missing = FILES.filter(([src]) => !existsSync(src));
if (missing.length) {
  console.error(
    "Devre ciktilari yok. Once calistirin:\n  npm run circuits:build\n",
  );
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
for (const [src, name] of FILES) {
  copyFileSync(src, join(OUT, name));
  console.log(`kopyalandi: public/circuits/${name}`);
}
