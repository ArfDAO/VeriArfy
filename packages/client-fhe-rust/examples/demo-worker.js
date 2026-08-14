/**
 * Faz 1 -> Faz 2 zincirinin tarayici kaniti.
 *
 * Iki wasm paketini de bundler olmadan yukler:
 *   VCF -> dozaj vektoru (veriarfy-vcf-parser)
 *        -> FHE blob     (veriarfy-client-fhe)
 *        -> cozum        (ayni dozajlar geri gelmeli)
 */
import initVcf, { parseBlob } from "../../client-side-rust/pkg/veriarfy_vcf_parser.js";
import initFhe, { FheClient } from "../pkg/veriarfy_client_fhe.js";

const post = (m) => self.postMessage(m);
const log = (line) => post({ type: "log", line });
const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;

function check(name, ok, detail) {
  post({ type: "case", name, ok, detail });
  return ok;
}

const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** N varyantlik gercek bir VCF metni uretir (dozaj deseni bilinir). */
function makeVcf(n) {
  const gts = ["0/0:30", "0/1:31", "1|1:19", "./.:0", "1/2:44"];
  let out =
    "##fileformat=VCFv4.3\n" +
    "##contig=<ID=chr1,length=248956422>\n" +
    '##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">\n' +
    '##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Read Depth">\n' +
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tNA12878\n";
  for (let i = 1; i <= n; i++) {
    out += `chr1\t${i}\trs${i}\tA\tG,T\t50\tPASS\t.\tGT:DP\t${gts[i % 5]}\n`;
  }
  return out;
}

self.onmessage = async () => {
  try {
    await initVcf({
      module_or_path: new URL("../../client-side-rust/pkg/veriarfy_vcf_parser_bg.wasm", import.meta.url),
    });
    const fheWasm = await initFhe({
      module_or_path: new URL("../pkg/veriarfy_client_fhe_bg.wasm", import.meta.url),
    });
    log("iki wasm modulu de yuklendi");

    // --- FAZ 1: VCF -> dozaj ------------------------------------------------
    const PANEL = 500;
    const vcf = makeVcf(PANEL);
    const parsed = await parseBlob(new Blob([vcf]));
    const dosages = parsed.dosages;
    parsed.free();
    log(`Faz 1: ${dosages.length} varyant ayristirildi — ilk 10: [${dosages.slice(0, 10)}]`);

    // --- Anahtar uretimi ----------------------------------------------------
    let t = performance.now();
    const client = FheClient.generate();
    const keygenMs = performance.now() - t;
    log(`anahtar uretildi: ${keygenMs.toFixed(0)} ms`);

    // Tarayicida OLCULEN sifreli metin boyutlari.
    const seededOne = client.ciphertextSizeBytes(true);
    const plainOne = client.ciphertextSizeBytes(false);

    // --- FAZ 2: sifreleme ---------------------------------------------------
    t = performance.now();
    const blob = client.encryptDosagesSeeded(dosages);
    const encMs = performance.now() - t;

    // --- ASIL KANIT: cozum orijinali geri veriyor mu? -----------------------
    t = performance.now();
    const back = client.decryptDosages(blob);
    const decMs = performance.now() - t;

    check(
      `${PANEL} dozaj sifrelendi -> cozuldu -> BIREBIR ayni`,
      eq(Array.from(dosages), Array.from(back)),
      `[${back.slice(0, 10)}...]`,
    );

    // --- Anahtar disari alinip geri yuklenince de cozuyor mu? ---------------
    const secret = client.exportSecretKey();
    const restored = FheClient.fromSecretKey(secret);
    check(
      "disa aktarilan gizli anahtar ayni blobu cozuyor",
      eq(Array.from(restored.decryptDosages(blob)), Array.from(dosages)),
      `anahtar ${kb(secret.length)}`,
    );

    // --- Baskasinin anahtari veriyi ele veriyor mu? -------------------------
    const stranger = FheClient.generate();
    const leaked = stranger.decryptDosages(blob);
    check(
      "yabanci anahtar gercek dozajlari ELE VERMIYOR",
      !eq(Array.from(leaked), Array.from(dosages)),
      `cikan: [${leaked.slice(0, 10)}...]`,
    );

    // --- Bozuk blob sessizce gecmiyor --------------------------------------
    let rejected = false;
    try {
      client.decryptDosages(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    } catch {
      rejected = true;
    }
    check("bozuk blob reddediliyor", rejected, "");

    // --- Duz vs tohumlanmis boyut ------------------------------------------
    const small = dosages.slice(0, 20);
    const plainBlob = client.encryptDosages(small);
    const seededBlob = client.encryptDosagesSeeded(small);
    check(
      "tohumlanmis blob duz bloktan cok daha kucuk",
      seededBlob.length * 10 < plainBlob.length,
      `20 dozaj: duz ${mb(plainBlob.length)} · tohumlu ${kb(seededBlob.length)}`,
    );

    post({
      type: "stats",
      rows: [
        ["panel boyutu", `${PANEL} varyant`],
        ["anahtar uretimi", `${keygenMs.toFixed(0)} ms`],
        ["sifreleme", `${encMs.toFixed(0)} ms (${(encMs / PANEL).toFixed(2)} ms/varyant)`],
        ["cozme", `${decMs.toFixed(0)} ms`],
        ["FheUint8 · duz", kb(plainOne)],
        ["FheUint8 · tohumlanmis", kb(seededOne)],
        ["oran", `${(plainOne / seededOne).toFixed(0)}x`],
        [`${PANEL} varyantlik blob`, mb(blob.length)],
        ["gizli anahtar (ClientKey)", kb(secret.length)],
        ["wasm heap", mb(fheWasm.memory.buffer.byteLength)],
      ],
    });

    post({ type: "done" });
  } catch (error) {
    post({ type: "fatal", message: String(error?.stack ?? error) });
  }
};
