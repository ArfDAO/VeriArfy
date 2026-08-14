/**
 * VeriArfy — sifreli AI cikarim istemcisi (tarayici tarafi).
 *
 * ## ONEMLI: bu modul kripto YAPMAZ, kriptoyu TAKAR
 *
 * Sifreleme, `ModelEncryptor` arayuzunun arkasindadir ve bu paket icinde bir
 * uygulamasi **yoktur**. Sebebi teknik bir gercek: `concrete-ml`'in tarayicida
 * calisan bir istemcisi yayinlanmamistir (npm'de `concrete-ml`,
 * `concrete-ml-extensions`, `@zama-fhe/concrete-ml` paketlerinin hicbiri
 * mevcut degil). Sahte bir sifreleyici koymak, "sifreli" gorunen ama aslinda
 * korumayan bir hat yaratirdi; bu yuzden encryptor verilmezse modul acikca
 * hata verir.
 *
 * Modulun **gercekten yaptigi** ve tek basina degerli olan is, sifrelemeden
 * bagimsiz olan ve sessizce bozulmaya en acik olan kisimdir:
 *
 *   - sunucunun guncel panelini cekmek,
 *   - Faz 1'in tam dozaj vektorunu panele **dogru sirayla** hizalamak,
 *   - tasima, dogrulama ve hata yonetimi.
 *
 * Panel hizasi kritiktir: istemci ile sunucu ayni indeks sirasini kullanmazsa
 * tahmin hata vermez, sadece **sessizce anlamsizlasir**. Bu yuzden sinir disi
 * ve tekrarlanan indeksler acikca reddedilir.
 */

// --------------------------------------------------------------------------------------
// Tipler
// --------------------------------------------------------------------------------------

/** Sunucunun `/api/panel` yaniti. */
export interface PanelSpec {
  panel_indices: number[];
  panel_variant_ids: string[];
  n_bits: number;
  label: string;
  source_vcf: string;
}

/** Sunucunun `/api/analyze` yaniti. */
export interface EncryptedAnalysis {
  ciphertext_result: string;
  panel_size: number;
  n_bits: number;
  label: string;
  compute_seconds: number;
  note: string;
}

/**
 * Modele ozel sifreleme yetenegi.
 *
 * Gizli anahtar bu arayuzun **arkasinda** kalir; modul onu hicbir zaman
 * gormez, tasimaz ve seri hale getirmez.
 */
export interface ModelEncryptor {
  /** Gunlukte/arayuzde gorunecek kisa ad. */
  readonly id: string;
  /** Sunucudan inen devre tanimiyla anahtarlari hazirlar (bir kez). */
  ensureKeys(clientSpecs: ArrayBuffer): Promise<void>;
  /** Panel dozajlarini sifreler. */
  encrypt(panelDosages: Uint8Array): Promise<Uint8Array>;
  /** Sunucunun sifreli veri uzerinde islem yapabilmesi icin gereken anahtar. */
  evaluationKeys(): Promise<Uint8Array>;
  /** Sifreli sonucu yerel gizli anahtarla cozer. */
  decrypt(encryptedResult: Uint8Array): Promise<number[]>;
}

export interface AnalysisResult {
  /** Cozulmus model ciktisi (ham skor / sinif olasiliklari). */
  output: number[];
  /** Sunucunun sifreli hesaplamada gecirdigi sure. */
  computeSeconds: number;
  /** Hangi hedef icin tahmin edildi. */
  label: string;
  panelSize: number;
}

export class FheAiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Kullanicinin duzeltebilecegi bir sey mi? */
    readonly actionable = false,
  ) {
    super(message);
    this.name = "FheAiError";
  }
}

// --------------------------------------------------------------------------------------
// Yapilandirma
// --------------------------------------------------------------------------------------

const env = import.meta.env ?? {};

/** Sifreli cikarim sunucusu (packages/ml, src.genomic.server). */
const API_BASE: string = env.VITE_FHE_AI_API ?? "http://localhost:8010";

const DEFAULT_TIMEOUT_MS = 120_000;

// --------------------------------------------------------------------------------------
// Sunucu ile konusma
// --------------------------------------------------------------------------------------

async function request(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE}${path}`, { ...init, signal: controller.signal });

    if (!response.ok) {
      // Sunucu, duzeltilebilir durumlar icin 4xx dondurur (or. anahtar
      // uyusmazligi); bunu kullaniciya aynen yansitmak isteriz.
      let detail = "";
      try {
        detail = (await response.json())?.detail ?? "";
      } catch {
        detail = await response.text().catch(() => "");
      }
      throw new FheAiError(
        `${path} basarisiz (${response.status})${detail ? `: ${detail}` : ""}`,
        response.status,
        response.status >= 400 && response.status < 500,
      );
    }

    return response;
  } catch (error) {
    if (error instanceof FheAiError) throw error;
    if (controller.signal.aborted) {
      throw new FheAiError(`${path} zaman asimina ugradi (${timeoutMs} ms)`);
    }
    throw new FheAiError(`${path} sunucusuna ulasilamadi: ${describe(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Sunucunun su an kullandigi panel tanimi. */
export async function fetchPanel(): Promise<PanelSpec> {
  const panel = (await (await request("/api/panel")).json()) as PanelSpec;

  if (!Array.isArray(panel.panel_indices) || panel.panel_indices.length === 0) {
    throw new FheAiError("sunucu bos ya da bozuk panel dondurdu");
  }

  return panel;
}

/** Istemcinin anahtar uretmek icin ihtiyac duydugu devre tanimi. */
export async function fetchClientSpecs(): Promise<ArrayBuffer> {
  return (await request("/api/keys/specs")).arrayBuffer();
}

/** Sunucunun hazir olup olmadigi ve egitim metrikleri. */
export async function fetchHealth(): Promise<Record<string, unknown>> {
  return (await request("/health", {}, 10_000)).json();
}

// --------------------------------------------------------------------------------------
// Panel hizalama
// --------------------------------------------------------------------------------------

/**
 * Faz 1'in tam dozaj vektorunden panelin istedigi varyantlari **panelin
 * sirasiyla** cikarir.
 *
 * Kurallar, Faz 2'deki Rust `select_panel` ile birebir aynidir ve bilincli
 * olarak burada TypeScript'te tekrar yazilmistir: yalnizca indeks secmek icin
 * 1,6 MB'lik FHE wasm modulunu ana thread'e yuklemek gereksiz bir maliyet
 * olurdu (sifreleme yolunda o modul zaten worker icinde yuklu).
 *
 * Iki durum sessizce gecmez, cunku ikisi de modelin gordugu vektoru kaydirir
 * ve tahmini **hicbir uyari vermeden** yanlislastirir:
 *   - sinir disi indeks,
 *   - tekrarlanan indeks.
 */
export function alignToPanel(dosages: Uint8Array, panel: PanelSpec): Uint8Array {
  const indices = panel.panel_indices;
  const seen = new Set<number>();
  const out = new Uint8Array(indices.length);

  for (let rank = 0; rank < indices.length; rank++) {
    const index = indices[rank];

    if (!Number.isInteger(index) || index < 0 || index >= dosages.length) {
      throw new FheAiError(
        `panelin ${rank}. indeksi (${index}) dozaj vektorunun disinda ` +
          `(vektor uzunlugu ${dosages.length}). VCF'iniz, panelin uretildigi ` +
          "referanstan farkli bir surumle olusturulmus olabilir.",
        undefined,
        true,
      );
    }

    if (seen.has(index)) {
      throw new FheAiError(`panelde tekrarlanan indeks: ${index} (${rank}. sirada)`);
    }
    seen.add(index);

    out[rank] = dosages[index];
  }

  return out;
}

// --------------------------------------------------------------------------------------
// Sifreli analiz
// --------------------------------------------------------------------------------------

/**
 * Tam akis: panel -> hizalama -> sifreleme -> sunucu -> cozme.
 *
 * Duz dozajlar cihazdan **cikmaz**; sunucuya yalnizca sifreli metin ve
 * degerlendirme anahtari gider, geri yalnizca sifreli sonuc gelir.
 */
export async function analyzeEncrypted(
  dosages: Uint8Array,
  options: {
    encryptor: ModelEncryptor;
    panel?: PanelSpec;
    onStage?: (stage: AnalysisStage) => void;
  },
): Promise<AnalysisResult> {
  const { encryptor, onStage } = options;

  if (!encryptor) {
    throw new FheAiError(
      "sifreleyici verilmedi. Bu modul kendi basina sifreleme yapmaz; " +
        "modele ozel bir ModelEncryptor takilmadan sifreli analiz calistirilamaz.",
    );
  }

  onStage?.("panel");
  const panel = options.panel ?? (await fetchPanel());

  onStage?.("align");
  const panelDosages = alignToPanel(dosages, panel);

  onStage?.("keys");
  await encryptor.ensureKeys(await fetchClientSpecs());

  onStage?.("encrypt");
  const ciphertext = await encryptor.encrypt(panelDosages);
  const evaluationKeys = await encryptor.evaluationKeys();

  onStage?.("infer");
  const response = (await request("/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ciphertext: toBase64(ciphertext),
      evaluation_keys: toBase64(evaluationKeys),
    }),
  }).then((r) => r.json())) as EncryptedAnalysis;

  onStage?.("decrypt");
  const output = await encryptor.decrypt(fromBase64(response.ciphertext_result));

  onStage?.("done");
  return {
    output,
    computeSeconds: response.compute_seconds,
    label: response.label,
    panelSize: response.panel_size,
  };
}

export type AnalysisStage =
  | "panel"
  | "align"
  | "keys"
  | "encrypt"
  | "infer"
  | "decrypt"
  | "done";

// --------------------------------------------------------------------------------------
// Yardimcilar
// --------------------------------------------------------------------------------------

/** Buyuk dizilerde `String.fromCharCode(...arr)` yigini tasirir; parcali gider. */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
