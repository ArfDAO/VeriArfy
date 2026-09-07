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

// KAYNAK YOKSA AMA HEDEF VARSA: sessizce gec.
//
// `packages/circuits/build/` gitignore'da; Vercel gibi temiz bir derleme
// ortaminda hic bulunmaz. Onceden burasi kosulsuz `exit(1)` yapiyordu ve
// site DERLENMIYORDU.
//
// `public/circuits/` artik islendigi icin dosyalar zaten depoda. Uretim
// derlemesinde kopyalanacak bir sey yok, kopyalanmasi da GEREKMIYOR:
// islenmis zkey zincirdeki dogrulayiciyla eslesen surumdur.
const alreadyServed = FILES.every(([, name]) => existsSync(join(OUT, name)));

if (missing.length) {
  if (alreadyServed) {
    console.log("Devre ciktilari zaten public/circuits altinda — kopyalama atlandi.");
    process.exit(0);
  }
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
