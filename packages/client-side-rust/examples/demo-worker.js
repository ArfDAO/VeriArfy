/**
 * Tarayici demosunun worker'i.
 *
 * `wasm-pack --target web` ciktisini **bundler olmadan**, dogrudan relative ESM
 * import'u ile yukler. Amaci: yayinlanan `pkg/` artefaktinin gercek tarayicida
 * calistigini kanitlamak.
 */
import init, { parseBlob, VcfStreamParser } from "../pkg/veriarfy_vcf_parser.js";

let wasm = null;

const log = (line) => self.postMessage({ type: "log", line });
const heapMB = () => (wasm.memory.buffer.byteLength / 1048576).toFixed(1);

/** Bilinen girdi -> bilinen cikti. */
const FIXTURE = `##fileformat=VCFv4.3
##contig=<ID=chr1,length=248956422>
##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Read Depth">
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tNA12878\tNA12891
chr1\t100\trs1\tA\tG\t50\tPASS\t.\tGT:DP\t0/0:30\t1/1:28
chr1\t200\trs2\tC\tT\t50\tPASS\t.\tGT:DP\t0/1:31\t0/0:22
chr1\t300\trs3\tG\tA\t50\tPASS\t.\tGT:DP\t1|1:19\t1/0:25
chr1\t400\trs4\tT\tC\t50\tPASS\t.\tGT:DP\t./.:0\t0/1:12
chr1\t500\trs5\tA\tG,T\t50\tPASS\t.\tGT:DP\t1/2:44\t0/2:17
chr1\t600\trs6\tA\tG\t50\tPASS\t.\tDP\t33\t21
`;

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function check(name, actual, expected) {
  const ok = Array.isArray(expected) ? same(Array.from(actual), expected) : actual === expected;
  self.postMessage({
    type: "case",
    name,
    ok,
    actual: Array.isArray(expected) ? `[${Array.from(actual)}]` : String(actual),
    expected: Array.isArray(expected) ? `[${expected}]` : String(expected),
  });
  return ok;
}

self.onmessage = async () => {
  try {
    wasm = await init({ module_or_path: new URL("../pkg/veriarfy_vcf_parser_bg.wasm", import.meta.url) });
    log(`wasm yuklendi — baslangic heap: ${heapMB()} MB`);

    // --- 1) Eslesme kurallari -----------------------------------------------
    const r1 = await parseBlob(new Blob([FIXTURE]));
    check("0/0 · 0/1 · 1|1 · ./. · 1/2  ->  dozaj", r1.dosages, [0, 1, 2, 0, 2]);
    check("ornek adi (varsayilan = ilk kolon)", r1.sampleName, "NA12878");
    check("GT'siz satir atlandi (skippedLineCount)", r1.skippedLineCount, 1);
    check("eksik genotip sayildi (missingGenotypeCount)", r1.missingGenotypeCount, 1);
    r1.free();

    const r2 = await parseBlob(new Blob([FIXTURE]), "NA12891");
    check("ikinci ornek adiyla secildi", r2.dosages, [2, 0, 1, 1, 1]);
    r2.free();

    // --- 2) Chunk siniri cikti degistirmemeli --------------------------------
    const bytes = new TextEncoder().encode(FIXTURE);
    let allEqual = true;
    for (const size of [1, 2, 3, 7, 13, 64, 127, 1024]) {
      const p = new VcfStreamParser();
      for (let i = 0; i < bytes.length; i += size) p.pushChunk(bytes.subarray(i, i + size));
      const out = p.finish();
      allEqual &&= same(Array.from(out.dosages), [0, 1, 2, 0, 2]);
      out.free();
    }
    check("1–1024 bayt arasi 8 farkli chunk boyutu ayni sonucu verdi", allEqual, true);

    // --- 3) Bozuk girdi sessizce gecmemeli ----------------------------------
    let threw = "";
    try {
      const p = new VcfStreamParser();
      p.pushChunk(new TextEncoder().encode("chr1\t100\t.\tA\tG\t.\t.\t.\tGT\t0/1\n"));
    } catch (e) {
      threw = e.message;
    }
    check("header'siz veri satiri hata veriyor", threw.length > 0, true);
    log(`  ↳ hata mesaji: "${threw}"`);

    // --- 4) Buyuk dosya: streaming + bellek ---------------------------------
    const CHUNK_MB = 1;
    const TARGET_MB = 400;
    const gts = ["0/0:30", "0/1:31", "1|1:19", "./.:0", "1/2:44"];
    let body = "";
    let pos = 0;
    while (body.length < CHUNK_MB * 1048576) {
      body += `chr1\t${++pos}\t.\tA\tG\t50\tPASS\t.\tGT:DP\t${gts[pos % 5]}\t0/0:9\n`;
    }
    const header = FIXTURE.split("\n").slice(0, 5).join("\n") + "\n";
    const bigBlob = new Blob([header, ...Array(TARGET_MB).fill(body)], { type: "text/plain" });
    log(`sentetik VCF olusturuldu: ${(bigBlob.size / 1048576).toFixed(1)} MB`);

    const heapBefore = wasm.memory.buffer.byteLength;
    const t0 = performance.now();
    const big = await parseBlob(bigBlob, null, (done, total, variants) => {
      self.postMessage({
        type: "progress",
        percent: total ? (done / total) * 100 : 0,
        variants,
        heapMB: Number(heapMB()),
      });
    });
    const secs = (performance.now() - t0) / 1000;
    const heapAfter = wasm.memory.buffer.byteLength;

    self.postMessage({
      type: "big",
      sizeMB: (bigBlob.size / 1048576).toFixed(1),
      variants: big.variantCount,
      secs: secs.toFixed(2),
      mbPerSec: (bigBlob.size / 1048576 / secs).toFixed(0),
      heapBeforeMB: (heapBefore / 1048576).toFixed(1),
      heapAfterMB: (heapAfter / 1048576).toFixed(1),
      dosageMB: (big.dosages.length / 1048576).toFixed(1),
      head: Array.from(big.dosages.slice(0, 15)).join(", "),
    });
    check("400 MB akista dozaj deseni bozulmadi", big.dosages.slice(0, 10), [
      1, 2, 0, 2, 0, 1, 2, 0, 2, 0,
    ]);
    big.free();

    self.postMessage({ type: "done" });
  } catch (error) {
    self.postMessage({ type: "fatal", message: String(error?.stack ?? error) });
  }
};
