/**
 * Tarayici tarafi FHE — Zama Relayer SDK (gercek sifreleme, simulasyon yok).
 *
 * Sifreleme kullanicinin cihazinda yapilir; duz puan hicbir zaman aga cikmaz.
 * Sonuclari okurken yalnizca GRUP DUZEYINDEKI toplamlar herkese acik cozulur.
 */
import { initSDK, createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/web";

let instancePromise: Promise<any> | null = null;

/**
 * SDK'nin wasm modullerinin ACIK adresleri.
 *
 * # Neden acikca veriliyor
 *
 * SDK, wasm'ini kendisi `new URL('tfhe_bg.wasm', import.meta.url)` ile
 * bulmaya calisir. Vite gelistirmede paketi on-derleyip
 * `node_modules/.vite/deps/` altina tasidigi icin bu adres, yaninda wasm
 * OLMAYAN bir klasore duser; dev sunucusu da bulunamayan yola index.html
 * dondurur ve hata sebebi hic belli olmayan sekilde soyle cikar:
 *
 *     WebAssembly.instantiate(): expected magic word 00 61 73 6d,
 *                                found 3c 21 64 6f      ("<!do" = HTML)
 *
 * Dosyalar `scripts/prepare-fhe-wasm.js` ile `public/fhe/` altina kopyalanir
 * (paketin `exports` alani derin ithale izin vermiyor) ve bu adresler hem
 * gelistirmede hem uretim derlemesinde ayni sekilde calisir.
 */
const TFHE_WASM = `${import.meta.env.BASE_URL}fhe/tfhe_bg.wasm`;
const KMS_WASM = `${import.meta.env.BASE_URL}fhe/kms_lib_bg.wasm`;

/** SDK'yi bir kez baslatir ve ornegi paylasir. */
export function getFheInstance(): Promise<any> {
  if (!instancePromise) {
    instancePromise = (async () => {
      // Coklu is parcacigi COOP/COEP basliklari ister; onlar olmadan SDK
      // uyari basip TEK PARCACIGA duser. Calisir, yalnizca daha yavastir —
      // basliklari acmak RPC ve relayer isteklerini kirabilecegi icin
      // bilincli olarak acilmadi.
      await initSDK({ tfheParams: TFHE_WASM, kmsParams: KMS_WASM });

      return createInstance({
        ...SepoliaConfig,
        network: (window as any).ethereum,
      });
    })();
  }
  return instancePromise;
}

/**
 * Anket yanitini tek bir sifreli girdi paketinde sifreler.
 * Kontrat ucunu birebir karsilar: add8(group) + add32(anxiety) + add32(panic).
 */
export async function encryptSubmission(params: {
  contractAddress: string;
  userAddress: string;
  group: number;
  anxiety: number;
  panic: number;
}): Promise<{ handles: string[]; inputProof: string }> {
  const instance = await getFheInstance();

  const buffer = instance.createEncryptedInput(
    params.contractAddress,
    params.userAddress,
  );
  buffer.add8(params.group);
  buffer.add32(params.anxiety);
  buffer.add32(params.panic);

  const enc = await buffer.encrypt();

  return {
    handles: enc.handles.map(toHex),
    inputProof: toHex(enc.inputProof),
  };
}

/**
 * Panele hizalanmis dozajlari tek bir sifreli girdi paketinde sifreler.
 *
 * @param contractAddress `VeriarfyProtocol` adresi — girdi kaniti buna baglidir.
 * @param dosages Panel SIRASINDA dozajlar (0 | 1 | 2 ya da 3 = eksik).
 */
export async function encryptDosages(params: {
  contractAddress: string;
  userAddress: string;
  dosages: number[];
}): Promise<{ handles: string[]; inputProof: string }> {
  const instance = await getFheInstance();

  const buffer = instance.createEncryptedInput(
    params.contractAddress,
    params.userAddress,
  );
  for (const dosage of params.dosages) buffer.add8(dosage);

  const enc = await buffer.encrypt();

  return {
    handles: enc.handles.map(toHex),
    inputProof: toHex(enc.inputProof),
  };
}

/**
 * Tek bir sifreli grup etiketi (vaka / kontrol) uretir.
 *
 * @remarks Grup BIR KEZ yazilir ve tum partilerde yeniden kullanilir; bu
 *          yuzden ayri bir paket olarak sifrelenir.
 */
export async function encryptGroup(params: {
  contractAddress: string;
  userAddress: string;
  group: number;
}): Promise<{ handle: string; inputProof: string }> {
  const instance = await getFheInstance();

  const buffer = instance.createEncryptedInput(
    params.contractAddress,
    params.userAddress,
  );
  buffer.add8(params.group);

  const enc = await buffer.encrypt();

  return { handle: toHex(enc.handles[0]), inputProof: toHex(enc.inputProof) };
}

/**
 * Olcekli biyobelirtec olcumlerini tek bir sifreli girdi paketinde sifreler.
 *
 * @param contractAddress `VeriarfyBiomarkers` ADRESI — protokolunki DEGIL.
 *        Girdi kaniti kontrat adresine baglidir; yanlis adresle sifrelenen
 *        olcumu `fromExternal` gecersiz sayar ve islem revert eder.
 * @param values Panel sirasinda KODLANMIS degerler (`metrics.ts`).
 */
export async function encryptBiomarkers(params: {
  contractAddress: string;
  userAddress: string;
  values: number[];
}): Promise<{ handles: string[]; inputProof: string }> {
  const instance = await getFheInstance();

  const buffer = instance.createEncryptedInput(
    params.contractAddress,
    params.userAddress,
  );
  for (const value of params.values) buffer.add32(value);

  const enc = await buffer.encrypt();

  return {
    handles: enc.handles.map(toHex),
    inputProof: toHex(enc.inputProof),
  };
}

/**
 * Esikli cozumun HAM sonucu — duz degerler ve KMS imzalari birlikte.
 *
 * @dev SDK 0.4.x su zarfi dondurur:
 *        { clearValues, abiEncodedClearValues, decryptionProof }
 *      Duz degerler `clearValues` ICINDEDIR; zarfin kendisi handle->deger
 *      eslemesi DEGILDIR. `decryptionProof`, KMS dugumlerinin EIP-712
 *      imzalaridir ve zincirde dogrulanabilir — Nadirlik Carpani (rapor §4.3)
 *      bunu kullanir.
 */
export async function publicDecryptRaw(handles: string[]): Promise<{
  clearValues: Record<string, unknown>;
  abiEncodedClearValues: string;
  decryptionProof: string;
}> {
  const instance = await getFheInstance();
  return instance.publicDecrypt(handles);
}

/**
 * Grup duzeyindeki toplamlari herkese acik olarak cozer.
 * @param handles bytes32 handle listesi
 * @returns handle -> duz deger
 */
export async function publicDecrypt(handles: string[]): Promise<Record<string, bigint>> {
  const { clearValues } = await publicDecryptRaw(handles);
  const out: Record<string, bigint> = {};
  for (const [handle, value] of Object.entries(clearValues)) {
    out[handle.toLowerCase()] = BigInt(value as any);
  }
  return out;
}

function toHex(value: Uint8Array | string): string {
  if (typeof value === "string") return value;
  return "0x" + Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sifir handle'i (hic katki yapilmamis toplam) — cozmeye gerek yok. */
export function isZeroHandle(handle: string): boolean {
  return /^0x0*$/.test(handle);
}
