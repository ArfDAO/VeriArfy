/**
 * VeriArfy — `useVcfParser`
 *
 * Wasm VCF parser'ini bir Web Worker uzerinden React'e baglar.
 *
 * ```tsx
 * const { parse, progress, result, error, busy } = useVcfParser();
 *
 * <input
 *   type="file"
 *   accept=".vcf,.vcf.gz"
 *   onChange={(e) => e.target.files?.[0] && parse(e.target.files[0])}
 * />
 * {busy && <progress value={progress.percent ?? 0} max={100} />}
 * {result && <p>{result.variantCount} varyant · ornek: {result.sampleName}</p>}
 * ```
 *
 * `result.dosages` dogrudan FHE sifrelemesine verilebilir:
 * her eleman `0 | 1 | 2` (bkz. `packages/web/src/lib/fhe.ts`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { VcfWorkerRequest, VcfWorkerResponse } from "./vcfWorker";

export interface VcfProgress {
  bytesProcessed: number;
  totalBytes: number | null;
  variantCount: number;
  /** Toplam boyut biliniyorsa 0-100; `.gz` akislarinda `null`. */
  percent: number | null;
}

export interface VcfDosages {
  /** FHE'ye girecek vektor; her eleman 0 | 1 | 2. */
  dosages: Uint8Array;
  sampleName: string;
  sampleNames: string[];
  variantCount: number;
  /** `./.` oldugu icin 0 yazilan varyant sayisi — veri kalitesi gostergesi. */
  missingGenotypeCount: number;
  /** GT alani olmadigi icin atlanan satir sayisi. */
  skippedLineCount: number;
}

const IDLE: VcfProgress = {
  bytesProcessed: 0,
  totalBytes: null,
  variantCount: 0,
  percent: null,
};

export function useVcfParser() {
  const workerRef = useRef<Worker | null>(null);
  const [progress, setProgress] = useState<VcfProgress>(IDLE);
  const [result, setResult] = useState<VcfDosages | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Worker'i bilesen omru boyunca tek sefer ayaga kaldir.
  useEffect(() => {
    const worker = new Worker(new URL("./vcfWorker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<VcfWorkerResponse>) => {
      const message = event.data;

      if (message.type === "progress") {
        setProgress({
          bytesProcessed: message.bytesProcessed,
          totalBytes: message.totalBytes,
          variantCount: message.variantCount,
          percent: message.totalBytes
            ? Math.min(100, (message.bytesProcessed / message.totalBytes) * 100)
            : null,
        });
        return;
      }

      if (message.type === "error") {
        setError(message.message);
        setBusy(false);
        return;
      }

      const { type: _type, ...dosages } = message;
      setResult(dosages);
      setBusy(false);
    };

    worker.onerror = (event) => {
      setError(event.message || "VCF worker beklenmedik sekilde durdu");
      setBusy(false);
    };

    return () => worker.terminate();
  }, []);

  const parse = useCallback((file: File | Blob, sampleName?: string) => {
    const worker = workerRef.current;
    if (!worker) return;

    setError(null);
    setResult(null);
    setProgress({ ...IDLE, totalBytes: file.size });
    setBusy(true);

    const name = file instanceof File ? file.name.toLowerCase() : "";
    const request: VcfWorkerRequest = {
      file,
      sampleName,
      gzip: name.endsWith(".gz") || name.endsWith(".bgz"),
    };

    // File/Blob structured-clone ile tasinir: icerik degil, referans kopyalanir.
    worker.postMessage(request);
  }, []);

  const reset = useCallback(() => {
    setProgress(IDLE);
    setResult(null);
    setError(null);
    setBusy(false);
  }, []);

  // Memoize: aksi halde her render'da yeni referans olusur ve tuketici bunu bir
  // `useEffect` bagimliligina koydugunda effect tekrar tekrar tetiklenir.
  return useMemo(
    () => ({ parse, reset, progress, result, error, busy }),
    [parse, reset, progress, result, error, busy],
  );
}
