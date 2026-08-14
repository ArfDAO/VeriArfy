/**
 * VeriArfy — `useFheEncryptor`
 *
 * FHE worker'ini React'e baglar. Anahtar uretimi ~4 saniye surdugu icin tum
 * agir isler worker'da kosar; bu hook yalnizca komut gonderip durum tutar.
 *
 * ```tsx
 * const fhe = useFheEncryptor();
 * const { result } = useVcfParser();          // Faz 1
 *
 * // 1) Anahtar (bir kez)
 * await fhe.generateKey();
 *
 * // 2) Panel onizlemesi — sifrelemeden, aninda
 * const preview = await fhe.previewPanel(result.dosages, STUDY_PANEL);
 *
 * // 3) Sifrele
 * const enc = await fhe.encrypt(result.dosages, { panel: STUDY_PANEL });
 * // enc.blob -> IPFS,  enc.sizeBytes -> arayuz
 * ```
 *
 * **Gizli anahtar:** worker belleginde durur, kendiliginden hicbir yere
 * yazilmaz. `exportSecretKey()` cagirmadikca main thread'e bile gecmez;
 * nereye saklanacagi (ve sifrelenip sifrelenmeyecegi) uygulamanin karari.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  BlobSummary,
  EncryptedPanel,
  FheRequest,
  FheResponse,
} from "./fheWorker";

export type { BlobSummary, EncryptedPanel };

export type FheStatus = "idle" | "keygen" | "encrypting" | "ready" | "error";

/** `generateKey` / `restoreKey` sonucu. */
export interface KeyReport {
  /** Islemin surdugu sure (ms). Anahtar uretimi tipik olarak ~4000 ms. */
  elapsedMs: number;
  /** Tek bir sifreli dozajin bayt maliyeti — panel boyutu hesabi icin. */
  ciphertextBytes: number;
}

export interface EncryptOptions {
  /**
   * Sifrelenecek varyantlarin Faz 1 vektorundeki indeksleri. Verilmezse tum
   * vektor sifrelenir — WGS olceginde bu **gigabaytlarca** blob demektir,
   * bilerek yapin.
   */
  panel?: Uint32Array | number[];
  /** Varsayilan `true`: tohumlanmis sifreli metin, 128 kat kucuk blob. */
  seeded?: boolean;
}

const toU32 = (panel: Uint32Array | number[]) =>
  panel instanceof Uint32Array ? panel : Uint32Array.from(panel);

/**
 * `Omit<FheRequest, "id">` dogrudan kullanilamaz: `Omit` birlesimi duzlestirip
 * yalnizca ortak alanlari birakir, boylece `dosages`/`blob` gibi varyanta ozgu
 * alanlar tip hatasi verir. Kosullu tip dagitimli calisir ve birlesimi korur.
 */
type WithoutId<T> = T extends { id: number } ? Omit<T, "id"> : never;

export function useFheEncryptor() {
  const workerRef = useRef<Worker | null>(null);
  /** id -> bekleyen istegi cozecek fonksiyonlar. */
  const pending = useRef(new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>());
  const nextId = useRef(1);

  const [status, setStatus] = useState<FheStatus>("idle");
  const [keyReady, setKeyReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Tek bir sifreli dozajin bayt maliyeti — panel boyutu uyarisi icin. */
  const [ciphertextBytes, setCiphertextBytes] = useState<number | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL("./fheWorker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    worker.onmessage = ({ data }: MessageEvent<FheResponse>) => {
      const entry = pending.current.get(data.id);
      if (!entry) return;
      pending.current.delete(data.id);

      if (data.ok) entry.resolve(data.result);
      else entry.reject(new Error(data.error));
    };

    worker.onerror = (event) => {
      const message = event.message || "FHE worker beklenmedik sekilde durdu";
      setError(message);
      setStatus("error");
      // Bekleyen tum istekleri sonsuza kadar asili birakma.
      for (const [, entry] of pending.current) entry.reject(new Error(message));
      pending.current.clear();
    };

    return () => {
      worker.terminate();
      pending.current.clear();
    };
  }, []);

  /** Worker'a komut gonderip yanitini bekler. */
  const send = useCallback(<T,>(request: WithoutId<FheRequest>, transfer: Transferable[] = []) => {
    const worker = workerRef.current;
    if (!worker) return Promise.reject(new Error("FHE worker henuz hazir degil"));

    const id = nextId.current++;
    return new Promise<T>((resolve, reject) => {
      pending.current.set(id, { resolve, reject });
      worker.postMessage({ ...request, id } as FheRequest, transfer);
    });
  }, []);

  /** Komutu calistirirken durum/hata bayraklarini yonetir. */
  const run = useCallback(
    async <T,>(busyStatus: FheStatus, fn: () => Promise<T>): Promise<T> => {
      setError(null);
      setStatus(busyStatus);
      try {
        const value = await fn();
        setStatus("ready");
        return value;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        setStatus("error");
        throw e;
      }
    },
    [],
  );

  /**
   * Anahtar hazir olduktan sonra tek sifreli metnin gercek boyutunu olcer.
   *
   * Olculen degeri hem state'e yazar hem de **dondurur**: `await generateKey()`
   * satirindan hemen sonra `ciphertextBytes` state'i henuz cagiran kapanista
   * gorunmez (React bir sonraki render'da gunceller), bu yuzden deger
   * dogrudan sonucta da verilir.
   */
  const measure = useCallback(async () => {
    const bytes = await send<number>({ type: "ciphertextSize", seeded: true });
    setCiphertextBytes(bytes);
    return bytes;
  }, [send]);

  /** Anahtari uretir (~4 sn) ve sifreli metin boyutunu olcer. */
  const generateKey = useCallback(async (): Promise<KeyReport> => {
    const { elapsedMs } = await run<{ elapsedMs: number }>("keygen", () =>
      send({ type: "generateKey" }),
    );
    setKeyReady(true);
    return { elapsedMs, ciphertextBytes: await measure() };
  }, [run, send, measure]);

  /** Daha once saklanmis gizli anahtari geri yukler. */
  const restoreKey = useCallback(
    async (secretKey: Uint8Array): Promise<KeyReport> => {
      const { elapsedMs } = await run<{ elapsedMs: number }>("keygen", () =>
        send({ type: "restoreKey", secretKey }),
      );
      setKeyReady(true);
      return { elapsedMs, ciphertextBytes: await measure() };
    },
    [run, send, measure],
  );

  /**
   * Gizli anahtari disari alir. **Bu baytlar sifreyi cozer** — aga
   * gondermeyin, kullanicinin cihazinda saklayin.
   */
  const exportSecretKey = useCallback(
    () => send<Uint8Array>({ type: "exportSecretKey" }),
    [send],
  );

  /** Hesaplayan duguma gidecek ServerKey (~57 MB, sifre cozemez). */
  const exportServerKey = useCallback(
    () => send<Uint8Array>({ type: "exportServerKey" }),
    [send],
  );

  /**
   * Paneli sifrelemeden uygular — indeksler gecerli mi, kac varyant kaliyor?
   * Anahtar gerektirmez, aninda doner.
   */
  const previewPanel = useCallback(
    (dosages: Uint8Array, panel: Uint32Array | number[]) =>
      send<Uint8Array>({ type: "preview", dosages, panel: toU32(panel) }),
    [send],
  );

  const encrypt = useCallback(
    (dosages: Uint8Array, options: EncryptOptions = {}) =>
      run<EncryptedPanel>("encrypting", () =>
        send({
          type: "encrypt",
          dosages,
          panel: options.panel ? toU32(options.panel) : undefined,
          seeded: options.seeded ?? true,
        }),
      ),
    [run, send],
  );

  /** Blobu cozmeden basligini okur (surum, eleman sayisi, panel). */
  const inspect = useCallback(
    (blob: Uint8Array) => send<BlobSummary>({ type: "inspect", blob }),
    [send],
  );

  /** Gonderim oncesi dogrulama: blob gercekten benim verim mi? */
  const decrypt = useCallback(
    (blob: Uint8Array) => send<Uint8Array>({ type: "decrypt", blob }),
    [send],
  );

  /** Panel sifrelenirse blob kabaca kac bayt olur? */
  const estimateBytes = useCallback(
    (panelLength: number) => (ciphertextBytes === null ? null : ciphertextBytes * panelLength),
    [ciphertextBytes],
  );

  // Donen nesne memoize edilir: aksi halde her render'da yeni bir referans
  // olusur ve tuketici bunu bir `useEffect` bagimliligina koydugunda effect
  // sonsuz tetiklenir. Referans yalnizca gercekten bir sey degistiginde yenilenir.
  return useMemo(
    () => ({
      status,
      busy: status === "keygen" || status === "encrypting",
      keyReady,
      error,
      ciphertextBytes,
      generateKey,
      restoreKey,
      exportSecretKey,
      exportServerKey,
      previewPanel,
      encrypt,
      inspect,
      decrypt,
      estimateBytes,
    }),
    [
      status,
      keyReady,
      error,
      ciphertextBytes,
      generateKey,
      restoreKey,
      exportSecretKey,
      exportServerKey,
      previewPanel,
      encrypt,
      inspect,
      decrypt,
      estimateBytes,
    ],
  );
}
