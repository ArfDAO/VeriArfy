/**
 * VeriArfy — VCF ayristirma Web Worker'i.
 *
 * 1-5 GB'lik bir dosyayi main thread'de islemek arayuzu dondurur. Wasm modulu
 * bu worker icinde calisir; main thread yalnizca ilerleme mesajlari alir.
 *
 * Onemli: Dosya (File/Blob) worker'a `postMessage` ile gonderilir — bu, dosyanin
 * *icerigini* kopyalamaz, sadece disk uzerindeki bloba bir referans tasir.
 * Yani 5 GB'lik dosya hicbir noktada RAM'e alinmaz.
 */

import init, {
  VcfStreamParser,
  parseBlob,
  parseReadableStream,
  type VcfParseResult,
} from "@veriarfy/client-side-rust/pkg/veriarfy_vcf_parser.js";
import wasmUrl from "@veriarfy/client-side-rust/pkg/veriarfy_vcf_parser_bg.wasm?url";

/**
 * BGZF (bgzip) akisini cozer.
 *
 * NEDEN GEREKLI: gercek dunyadaki her `.vcf.gz` bgzip ciktisidir ve **cok
 * uyeli** bir gzip akisidir. Tarayicinin `DecompressionStream("gzip")` cozucusu
 * ilk uyeden sonrasini okumaz; 1000 Genomes chrMT dosyasiyla olculdu:
 * dogrudan cozmeye calisinca akis hata veriyor, uye uye cozunce 306 uyeden
 * 19.887.196 bayt sorunsuz cikiyor.
 *
 * Bu fonksiyon uyeleri sirayla ayirip her birini ayri cozer, boylece akis
 * ozelligi korunur — dosyanin tamami bellege alinmaz.
 */
function bgzfDecompressStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let buffer = new Uint8Array(0);
  let done = false;

  /** Tampondaki ilk uyenin uzunlugu; yetersiz veri varsa -1. */
  const memberLength = (buf: Uint8Array): number => {
    if (buf.length < 18) return -1;
    if (buf[0] !== 0x1f || buf[1] !== 0x8b) {
      throw new Error("gecersiz gzip uyesi (sihirli sayi yok)");
    }
    if ((buf[3] & 4) === 0) return -2; // FEXTRA yok -> duz gzip, BGZF degil

    const xlen = buf[10] | (buf[11] << 8);
    if (buf.length < 12 + xlen) return -1;

    let p = 12;
    const end = 12 + xlen;
    while (p + 4 <= end) {
      const slen = buf[p + 2] | (buf[p + 3] << 8);
      if (buf[p] === 66 && buf[p + 1] === 67) {
        return (buf[p + 4] | (buf[p + 5] << 8)) + 1; // BSIZE
      }
      p += 4 + slen;
    }
    return -2; // BC alt-alani yok -> BGZF degil
  };

  const append = (a: Uint8Array, b: Uint8Array) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  };

  const inflate = async (member: Uint8Array): Promise<Uint8Array> => {
    const stream = new Blob([member as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const size = buffer.length ? memberLength(buffer) : -1;

        if (size === -2) {
          // BGZF degil: kalani duz gzip olarak coz ve bitir.
          const rest: Uint8Array[] = [buffer];
          while (!done) {
            const { value, done: finished } = await reader.read();
            if (finished) break;
            if (value) rest.push(value);
          }
          const merged = rest.reduce(append, new Uint8Array(0));
          controller.enqueue(await inflate(merged));
          controller.close();
          return;
        }

        if (size > 0 && buffer.length >= size) {
          const member = buffer.subarray(0, size);
          buffer = buffer.slice(size);
          const plain = await inflate(member);
          // BGZF sonu isaretcisi bos uyedir; atlanir.
          if (plain.length > 0) {
            controller.enqueue(plain);
            return;
          }
          continue;
        }

        if (done) {
          if (buffer.length > 0) throw new Error("BGZF akisi yarim bitti");
          controller.close();
          return;
        }

        const { value, done: finished } = await reader.read();
        done = finished;
        if (value) buffer = append(buffer, value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Panel filtresiyle akis ayristirmasi.
 *
 * @remarks Hazir `parseBlob` / `parseReadableStream` kisayollari filtre
 *          parametresi almadigi icin akis burada elle surulur. Filtre Rust
 *          tarafinda uygulanir; JS'e yalnizca panele giren varyantlar doner.
 */
async function parseWithPanel(
  stream: ReadableStream<Uint8Array>,
  sampleName: string | undefined,
  wantedIds: string[],
  totalBytes: number | null,
  onProgress: (bytes: number, total: number | null, variants: number) => void,
): Promise<VcfParseResult> {
  const parser = new VcfStreamParser(sampleName);
  parser.setWantedIds(wantedIds);
  // Panel boyutu biliniyor: dozaj vektoru tek seferde tahsis edilir.
  parser.reserve(wantedIds.length);

  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.pushChunk(value);
      onProgress(parser.bytesProcessed, totalBytes, parser.variantCount);
    }
    return parser.finish();
  } finally {
    reader.releaseLock();
  }
}

export interface VcfWorkerRequest {
  file: File | Blob;
  /** Cok ornekli VCF'te hedef ornek adi. Bos ise ilk kolon kullanilir. */
  sampleName?: string;
  /** `.vcf.gz` icin tarayicinin DecompressionStream'i ile acmayi dene. */
  gzip?: boolean;
  /**
   * Calisma panelinin rsID listesi.
   *
   * VERILDIGINDE sonuc `ids` alani dolar ve dozajlar panele HIZALANABILIR.
   * Verilmezse dosya sirasinda kimliksiz bir dizi doner — o dizi zincire
   * gonderilemez, cunku hangi varyanta ait oldugu bilinmez.
   *
   * Filtre Rust tarafinda uygulanir: tum genom VCF'i milyonlarca satirdir,
   * hepsini JS'e tasiyip sonra elemek isin buyuk kismini bellege tasimak
   * olurdu.
   */
  wantedIds?: string[];
}

export type VcfWorkerResponse =
  | { type: "progress"; bytesProcessed: number; totalBytes: number | null; variantCount: number }
  | {
      type: "done";
      dosages: Uint8Array;
      /** Dozajlarla AYNI SIRADA varyant kimlikleri; filtre yoksa bos. */
      ids: string[];
      filteredOutCount: number;
      sampleName: string;
      sampleNames: string[];
      variantCount: number;
      missingGenotypeCount: number;
      skippedLineCount: number;
    }
  | { type: "error"; message: string };

let ready: Promise<unknown> | null = null;

function post(message: VcfWorkerResponse, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(message, transfer);
}

self.onmessage = async (event: MessageEvent<VcfWorkerRequest>) => {
  const { file, sampleName, gzip, wantedIds } = event.data;

  try {
    // Wasm modulu worker basina bir kez yuklenir.
    ready ??= init({ module_or_path: wasmUrl });
    await ready;

    const onProgress = (
      bytesProcessed: number,
      totalBytes: number | null,
      variantCount: number,
    ) => post({ type: "progress", bytesProcessed, totalBytes, variantCount });

    // Panel filtresi gerekiyorsa akis parser'i ELLE surulur: hazir
    // `parseBlob`/`parseReadableStream` kisayollari filtre parametresi almaz.
    const stream = gzip
      ? bgzfDecompressStream(file.stream())
      : (file.stream() as ReadableStream<Uint8Array>);

    const result: VcfParseResult = wantedIds?.length
      ? await parseWithPanel(stream, sampleName, wantedIds, file.size ?? null, onProgress)
      : gzip
        ? await parseReadableStream(stream, sampleName, null, onProgress)
        : await parseBlob(file, sampleName, onProgress);

    const dosages = result.dosages;
    post(
      {
        type: "done",
        dosages,
        ids: result.ids,
        filteredOutCount: result.filteredOutCount,
        sampleName: result.sampleName,
        sampleNames: result.sampleNames,
        variantCount: result.variantCount,
        missingGenotypeCount: result.missingGenotypeCount,
        skippedLineCount: result.skippedLineCount,
      },
      // Kopyalama yok: dozaj tamponunun sahipligi main thread'e devredilir.
      [dosages.buffer],
    );

    result.free();
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
