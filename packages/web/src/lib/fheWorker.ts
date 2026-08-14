/**
 * VeriArfy — FHE sifreleme Web Worker'i.
 *
 * Anahtar uretimi ~4 saniye suren **senkron** bir islemdir; main thread'de
 * cagrilirsa tarayici o sure boyunca tamamen donar. Bu yuzden `FheClient`
 * yalnizca burada yasar.
 *
 * ## Gizli anahtar nerede duruyor?
 *
 * `FheClient` worker bellegindedir ve gizli anahtar **kendiliginden hicbir
 * yere yazilmaz**. Main thread'e yalnizca `exportSecretKey` komutu acikca
 * cagrildiginda gecer. Nereye (ve sifrelenip sifrelenmeden) saklanacagi
 * uygulamanin karari oldugu icin bu modul kendi basina localStorage/IndexedDB'ye
 * dokunmaz.
 */

import init, {
  FheClient,
  blobInfo,
  selectPanel,
} from "@veriarfy/client-fhe-rust/pkg/veriarfy_client_fhe.js";
import wasmUrl from "@veriarfy/client-fhe-rust/pkg/veriarfy_client_fhe_bg.wasm?url";

// --------------------------------------------------------------------------------------
// Protokol
// --------------------------------------------------------------------------------------

export type FheRequest =
  /** Anahtar uret (yavas: ~4 sn). */
  | { id: number; type: "generateKey" }
  /** Daha once disa aktarilmis anahtari geri yukle. */
  | { id: number; type: "restoreKey"; secretKey: Uint8Array }
  /** Gizli anahtari disari al — cagiran taraf saklamaktan sorumludur. */
  | { id: number; type: "exportSecretKey" }
  /** Hesaplayan duguma gidecek ServerKey (~57 MB). */
  | { id: number; type: "exportServerKey" }
  /**
   * Dozajlari sifrele. `panel` verilirse yalnizca o indeksler sifrelenir;
   * verilmezse tum vektor.
   */
  | {
      id: number;
      type: "encrypt";
      dosages: Uint8Array;
      panel?: Uint32Array;
      /** Varsayilan `true` — 128 kat kucuk blob. */
      seeded?: boolean;
    }
  /** Sifrelemeden panel onizlemesi (aninda doner). */
  | { id: number; type: "preview"; dosages: Uint8Array; panel: Uint32Array }
  /** Tek sifreli metnin bayt maliyeti — boyut uyarisi icin. */
  | { id: number; type: "ciphertextSize"; seeded?: boolean }
  /** Blobu cozmeden basligini oku. */
  | { id: number; type: "inspect"; blob: Uint8Array }
  /** Blobu coz — gonderim oncesi dogrulama. */
  | { id: number; type: "decrypt"; blob: Uint8Array };

export interface EncryptedPanel {
  blob: Uint8Array;
  /** Sifrelenen dozaj sayisi. */
  count: number;
  /** Blobun tasidigi panel indeksleri (tam vektorde `null`). */
  panel: number[] | null;
  sizeBytes: number;
  /** Sifrelemenin surdugu sure (ms) — arayuzde gostermek icin. */
  elapsedMs: number;
}

export interface BlobSummary {
  version: number;
  count: number;
  panel: number[] | null;
  sizeBytes: number;
}

export type FheResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

// --------------------------------------------------------------------------------------
// Durum
// --------------------------------------------------------------------------------------

let ready: Promise<unknown> | null = null;
let client: FheClient | null = null;

function requireClient(): FheClient {
  if (!client) {
    throw new Error("once bir anahtar uretin ya da yukleyin (generateKey / restoreKey)");
  }
  return client;
}

/** Eski anahtari serbest birak — wasm heap'i ~289 MB'a cikabiliyor. */
function replaceClient(next: FheClient) {
  client?.free();
  client = next;
}

// --------------------------------------------------------------------------------------
// Komut isleyici
// --------------------------------------------------------------------------------------

async function handle(request: FheRequest): Promise<{ result: unknown; transfer: Transferable[] }> {
  ready ??= init({ module_or_path: wasmUrl });
  await ready;

  switch (request.type) {
    case "generateKey": {
      const t0 = performance.now();
      replaceClient(FheClient.generate());
      return { result: { elapsedMs: performance.now() - t0 }, transfer: [] };
    }

    case "restoreKey": {
      replaceClient(FheClient.fromSecretKey(request.secretKey));
      return { result: { elapsedMs: 0 }, transfer: [] };
    }

    case "exportSecretKey": {
      const bytes = requireClient().exportSecretKey();
      return { result: bytes, transfer: [bytes.buffer] };
    }

    case "exportServerKey": {
      const bytes = requireClient().exportServerKey();
      return { result: bytes, transfer: [bytes.buffer] };
    }

    case "encrypt": {
      const c = requireClient();
      const seeded = request.seeded ?? true;
      const t0 = performance.now();

      const blob = request.panel
        ? seeded
          ? c.encryptPanelSeeded(request.dosages, request.panel)
          : c.encryptPanel(request.dosages, request.panel)
        : seeded
          ? c.encryptDosagesSeeded(request.dosages)
          : c.encryptDosages(request.dosages);

      const elapsedMs = performance.now() - t0;

      const info = blobInfo(blob);
      const result: EncryptedPanel = {
        blob,
        count: info.count,
        panel: info.panel ? Array.from(info.panel) : null,
        sizeBytes: info.sizeBytes,
        elapsedMs,
      };
      info.free();

      return { result, transfer: [blob.buffer] };
    }

    case "preview": {
      // Anahtar gerektirmez: panel dogru mu, kac varyant tutuyor?
      const selected = selectPanel(request.dosages, request.panel);
      return { result: selected, transfer: [selected.buffer] };
    }

    case "ciphertextSize":
      return {
        result: requireClient().ciphertextSizeBytes(request.seeded ?? true),
        transfer: [],
      };

    case "inspect": {
      const info = blobInfo(request.blob);
      const summary: BlobSummary = {
        version: info.version,
        count: info.count,
        panel: info.panel ? Array.from(info.panel) : null,
        sizeBytes: info.sizeBytes,
      };
      info.free();
      return { result: summary, transfer: [] };
    }

    case "decrypt": {
      const values = requireClient().decryptDosages(request.blob);
      return { result: values, transfer: [values.buffer] };
    }
  }
}

self.onmessage = async (event: MessageEvent<FheRequest>) => {
  const { id } = event.data;
  try {
    const { result, transfer } = await handle(event.data);
    (self as unknown as Worker).postMessage({ id, ok: true, result } satisfies FheResponse, transfer);
  } catch (error) {
    (self as unknown as Worker).postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies FheResponse);
  }
};
