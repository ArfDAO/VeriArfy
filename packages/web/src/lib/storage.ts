/**
 * VeriArfy — Merkeziyetsiz depolama (IPFS / Pinata).
 *
 * Faz 2'nin urettigi sifreli blobu IPFS'e yukler ve CID dondurur. Zincire
 * yazilacak olan sey bu CID'dir; verinin kendisi zincire hic girmez.
 *
 * ## Iki yol var ve varsayilan olan bilincli secildi
 *
 * | Strateji | Ne zaman | Risk |
 * |---|---|---|
 * | `proxy` (varsayilan) | Her zaman, uretim dahil | Yok — JWT sunucuda kalir |
 * | `direct` | Yalnizca yerel gelistirme | **JWT tarayiciya gomulur** |
 *
 * `VITE_PINATA_JWT` (Next.js'te `NEXT_PUBLIC_PINATA_JWT`) gibi bir degisken
 * **gizli degildir**: bundler onu uretilen JS'in icine duz metin olarak yazar,
 * yani siteyi acan herkes DevTools'tan okuyup sizin Pinata hesabiniza diledigi
 * veriyi pinleyebilir. Bu yuzden `direct` stratejisi kendiliginden devreye
 * girmez; acikca `VITE_PINATA_DIRECT=true` denmedikce kullanilmaz ve
 * kullanilirsa konsola uyari basar.
 *
 * ## Metadata uyarisi
 *
 * Pinata metadata'si Pinata tarafindan gorulur ve pin listesinde durur.
 * `keyvalues` icine **katilimciyi tanimlayabilecek hicbir sey koymayin**
 * (cuzdan adresi, e-posta, ornek adi, VCF dosya adi...). Sifreli veri gizli
 * olsa da metadata gizli degildir.
 */

// --------------------------------------------------------------------------------------
// Tipler
// --------------------------------------------------------------------------------------

export interface UploadResult {
  /** IPFS icerik kimligi — zincire yazilacak deger. */
  cid: string;
  /** Pinata'nin bildirdigi pin boyutu (bayt). */
  size: number;
  /** Pin zaman damgasi (ISO 8601). */
  pinnedAt: string;
  /** Okunabilir gateway adresi — dogrulama/onizleme icin. */
  gatewayUrl: string;
}

export interface UploadOptions {
  /** Pinata pin listesinde gorunecek ad. */
  name?: string;
  /**
   * Pinata anahtar/deger metadata'si. **Kisisel veri koymayin.**
   * Varsayilana eklenir, ayni anahtar verilirse ustune yazar.
   */
  keyvalues?: Record<string, string>;
  /** Toplam deneme sayisi (ilk deneme dahil). Varsayilan 3. */
  retries?: number;
  /** Tek bir denemenin zaman asimi (ms). Varsayilan 60_000. */
  timeoutMs?: number;
  /** Cagiran taraf iptal edebilsin diye. */
  signal?: AbortSignal;
  /** Her yeniden denemede cagrilir — arayuzde "3/3 deneniyor" gostermek icin. */
  onRetry?: (attempt: number, waitMs: number, reason: string) => void;
}

export class StorageError extends Error {
  constructor(
    message: string,
    /** HTTP durum kodu (ag hatasinda `undefined`). */
    readonly status?: number,
    /** Yeniden denemenin anlami var mi? */
    readonly retryable = false,
    /**
     * Sunucunun `Retry-After` ile bildirdigi bekleme suresi (ms).
     * Varsa kendi geri cekilme hesabimizin yerine bu kullanilir.
     */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

// --------------------------------------------------------------------------------------
// Yapilandirma
// --------------------------------------------------------------------------------------

const env = import.meta.env ?? {};

/** Sunucu tarafi yukleme vekili (curator servisi). */
const PROXY_URL: string = env.VITE_STORAGE_API ?? "http://localhost:8787";

/** Yalnizca gelistirmede: tarayicidan dogrudan Pinata'ya. */
const DIRECT_ENABLED = env.VITE_PINATA_DIRECT === "true";
const DIRECT_JWT: string | undefined = env.VITE_PINATA_JWT;

const PINATA_PIN_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";

/** Okuma icin gateway. Ozel gateway'iniz varsa `VITE_IPFS_GATEWAY` ile verin. */
const GATEWAY: string = env.VITE_IPFS_GATEWAY ?? "https://gateway.pinata.cloud/ipfs";

/**
 * Varsayilan metadata. `version`, Faz 2 blob format surumuyle ayni tutulur
 * (`FORMAT_VERSION` — bkz. `packages/client-fhe-rust/src/lib.rs`), boylece
 * eski surum bloblar pin listesinden ayirt edilebilir.
 */
const DEFAULT_NAME = "Veriarfy_Panel_Blob";
const DEFAULT_KEYVALUES: Record<string, string> = { version: "2" };

const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 60_000;

// --------------------------------------------------------------------------------------
// Genel API
// --------------------------------------------------------------------------------------

/**
 * Sifreli blobu IPFS'e yukler ve CID dondurur.
 *
 * ```ts
 * const enc = await fhe.encrypt(dosages, { panel: PANEL });
 * const { cid } = await uploadEncryptedBlob(enc.blob, {
 *   keyvalues: { panelSize: String(enc.count) },
 * });
 * // cid -> zincire
 * ```
 */
export async function uploadEncryptedBlob(
  blob: Uint8Array,
  options: UploadOptions = {},
): Promise<UploadResult> {
  if (blob.length === 0) {
    throw new StorageError("bos blob yuklenemez");
  }

  const metadata = {
    name: options.name ?? DEFAULT_NAME,
    keyvalues: { ...DEFAULT_KEYVALUES, ...options.keyvalues },
  };

  const useDirect = DIRECT_ENABLED && !!DIRECT_JWT;
  if (DIRECT_ENABLED && !DIRECT_JWT) {
    throw new StorageError(
      "VITE_PINATA_DIRECT=true ama VITE_PINATA_JWT tanimli degil",
    );
  }
  if (useDirect) {
    console.warn(
      "[storage] DOGRUDAN yukleme modu: Pinata JWT'si tarayici paketine gomuludur " +
        "ve herkes tarafindan okunabilir. Yalnizca yerel gelistirmede kullanin.",
    );
  }

  return withRetry(
    (signal) =>
      useDirect
        ? uploadDirect(blob, metadata, signal)
        : uploadViaProxy(blob, metadata, signal),
    options,
  );
}

/**
 * Yuklenen blobu gateway'den geri ceker.
 *
 * Zincire CID yazmadan **once** cagirmaya deger: veri gercekten aga ulasmis mi
 * ve baytlar birebir ayni mi? Zincire yazilan yanlis bir CID geri alinamaz.
 */
export async function fetchEncryptedBlob(
  cid: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const response = await fetchWithTimeout(
    `${GATEWAY}/${cid}`,
    { method: "GET" },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal,
  );

  if (!response.ok) {
    throw new StorageError(
      `IPFS'ten okunamadi (${response.status})`,
      response.status,
      isRetryableStatus(response.status),
    );
  }

  return new Uint8Array(await response.arrayBuffer());
}

/** `cid` icin okunabilir gateway adresi. */
export function gatewayUrl(cid: string): string {
  return `${GATEWAY}/${cid}`;
}

/** Hangi strateji aktif — arayuzde gostermek/uyarmak icin. */
export function storageMode(): "proxy" | "direct" {
  return DIRECT_ENABLED && DIRECT_JWT ? "direct" : "proxy";
}

// --------------------------------------------------------------------------------------
// Stratejiler
// --------------------------------------------------------------------------------------

interface PinMetadata {
  name: string;
  keyvalues: Record<string, string>;
}

/** Varsayilan yol: baytlari kendi sunucumuza gonderiyoruz, JWT orada duruyor. */
async function uploadViaProxy(
  blob: Uint8Array,
  metadata: PinMetadata,
  signal: AbortSignal,
): Promise<UploadResult> {
  const response = await fetch(`${PROXY_URL}/ipfs/upload`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      // Metadata basliklarda gider: govde ham sifreli bayt olarak kalir,
      // boylece vekil tarafta ek bir ayristirma katmani gerekmez.
      "x-pin-name": metadata.name,
      "x-pin-keyvalues": JSON.stringify(metadata.keyvalues),
    },
    body: toBodyInit(blob),
    signal,
  });

  return readPinResponse(response);
}

/** Yalnizca gelistirme: tarayicidan dogrudan Pinata'ya. */
async function uploadDirect(
  blob: Uint8Array,
  metadata: PinMetadata,
  signal: AbortSignal,
): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", new Blob([toBodyInit(blob)]), `${metadata.name}.bin`);
  form.append("pinataMetadata", JSON.stringify(metadata));
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

  const response = await fetch(PINATA_PIN_URL, {
    method: "POST",
    // content-type ELLE VERILMEZ: FormData kendi multipart sinirini yazar.
    headers: { authorization: `Bearer ${DIRECT_JWT}` },
    body: form,
    signal,
  });

  return readPinResponse(response);
}

// --------------------------------------------------------------------------------------
// Yanit ve hata cozumleme
// --------------------------------------------------------------------------------------

/**
 * Pin yanitini normalize eder.
 *
 * Pinata'nin eski pinning API'si `IpfsHash`, yeni Files API'si `data.cid`
 * dondurur; vekilimiz de sadelestirilmis `cid` dondurebilir. Ucunu de kabul
 * ederiz ki bir ucu degisince modul sessizce bozulmasin.
 */
async function readPinResponse(response: Response): Promise<UploadResult> {
  if (!response.ok) {
    throw new StorageError(
      `IPFS yuklemesi basarisiz (${response.status}): ${await safeText(response)}`,
      response.status,
      isRetryableStatus(response.status),
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }

  const body: any = await response.json().catch(() => ({}));
  const cid: string | undefined = body.IpfsHash ?? body.cid ?? body.data?.cid;

  if (!cid) {
    throw new StorageError(
      `yanitta CID yok: ${JSON.stringify(body).slice(0, 200)}`,
      response.status,
      false,
    );
  }

  return {
    cid,
    size: Number(body.PinSize ?? body.size ?? body.data?.size ?? 0),
    pinnedAt: body.Timestamp ?? body.pinnedAt ?? new Date().toISOString(),
    gatewayUrl: gatewayUrl(cid),
  };
}

/**
 * Hangi durum kodlari yeniden denemeye deger?
 *
 * - `408/425/429` ve tum `5xx`: gecici — denemeye deger.
 * - `401/403`: anahtar yanlis; tekrar denemek yalnizca kotayi yakar.
 * - `413`: blob cok buyuk; ayni blobu tekrar gondermek ayni sonucu verir.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * `Retry-After` basligini ms'e cevirir.
 *
 * Basligin iki bicimi vardir: saniye sayisi ya da HTTP tarihi. Sunucu kotanin
 * ne zaman yenilenecegini bizden iyi bilir; kendi tahminimizi ona tercih etmek
 * gereksiz yere erken donmek ve tekrar 429 yemek demektir.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());

  return undefined;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "<govde okunamadi>";
  }
}

// --------------------------------------------------------------------------------------
// Yeniden deneme
// --------------------------------------------------------------------------------------

/**
 * Ustel geri cekilme + jitter ile yeniden dener.
 *
 * Jitter onemli: ag koptugunda ayni anda yeniden baglanan tum istemciler
 * sabit gecikmeyle ayni saniyede geri gelir ve sunucuyu ikinci kez dusurur.
 */
async function withRetry(
  attempt: (signal: AbortSignal) => Promise<UploadResult>,
  options: UploadOptions,
): Promise<UploadResult> {
  const maxAttempts = Math.max(1, options.retries ?? DEFAULT_RETRIES);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: unknown;

  for (let n = 1; n <= maxAttempts; n++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      return await attempt(controller.signal);
    } catch (error) {
      lastError = error;

      // Cagiran taraf iptal ettiyse yeniden deneme.
      if (options.signal?.aborted) {
        throw new StorageError("yukleme iptal edildi");
      }

      const retryable = error instanceof StorageError ? error.retryable : true;
      if (!retryable || n === maxAttempts) break;

      // Sunucu ne kadar bekleyecegimizi soylediyse ona uyulur.
      const hinted = error instanceof StorageError ? error.retryAfterMs : undefined;
      const waitMs = hinted ?? backoffMs(n);
      options.onRetry?.(n, waitMs, describe(error));
      await sleep(waitMs);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  if (lastError instanceof StorageError) throw lastError;
  throw new StorageError(`IPFS yuklemesi basarisiz: ${describe(lastError)}`);
}

/** 500 ms, 1 sn, 2 sn… uzerine %0-50 rastgele jitter. */
function backoffMs(attempt: number): number {
  const base = 500 * 2 ** (attempt - 1);
  return Math.round(base * (1 + Math.random() * 0.5));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// --------------------------------------------------------------------------------------
// Yardimcilar
// --------------------------------------------------------------------------------------

/**
 * `Uint8Array`'i govdeye uygun hale getirir.
 *
 * Wasm'dan gelen dizi, `ArrayBuffer`'in yalnizca bir **dilimi** olabilir
 * (`byteOffset > 0`). Diziyi dogrudan vermek yerine ilgili araligi kopyalariz;
 * aksi halde bazi ortamlarda tum buffer gonderilir ve blob bozulur.
 */
function toBodyInit(blob: Uint8Array): ArrayBuffer {
  return blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  external?.addEventListener("abort", onAbort, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onAbort);
  }
}
