/**
 * Tarayici tarafi FHE — Zama Relayer SDK (gercek sifreleme, simulasyon yok).
 *
 * Sifreleme kullanicinin cihazinda yapilir; duz puan hicbir zaman aga cikmaz.
 * Sonuclari okurken yalnizca GRUP DUZEYINDEKI toplamlar herkese acik cozulur.
 */
import { initSDK, createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/web";

/**
 * SDK ornegININ kullandigimiz yuzeyi.
 *
 * @remarks Onceden `Promise<any>` donuyordu ve bu, gercek bir hatayi
 *          gizledi: `userDecrypt`'e sayi yerine metin gecirildi, TypeScript
 *          sustu, hata ancak calisma aninda ve anlasilmaz bir mesajla cikti
 *          (`InvalidTypeError undefined UintNumber string`).
 *
 *          Yuzey dar tutuluyor — SDK'nin tamamini yeniden tiplemek degil,
 *          yalnizca cagirdigimiz dortlu. Imzalar paketin `.d.ts`'inden
 *          birebir alinmistir.
 */
interface FheInstance {
  createEncryptedInput(contractAddress: string, userAddress: string): EncryptedInputBuilder;
  generateKeypair(): { publicKey: string; privateKey: string };
  createEIP712(
    publicKey: string,
    contractAddresses: string[],
    startTimestamp: number,
    durationDays: number,
  ): { domain: Record<string, unknown>; types: Record<string, unknown>; message: Record<string, unknown> };
  userDecrypt(
    handles: { handle: string; contractAddress: string }[],
    privateKey: string,
    publicKey: string,
    signature: string,
    contractAddresses: string[],
    userAddress: string,
    startTimestamp: number,
    durationDays: number,
  ): Promise<unknown>;
  publicDecrypt(handles: string[]): Promise<{
    clearValues: Record<string, unknown>;
    abiEncodedClearValues: string;
    decryptionProof: string;
  }>;
}

interface EncryptedInputBuilder {
  add8(value: number | bigint): EncryptedInputBuilder;
  add32(value: number | bigint): EncryptedInputBuilder;
  encrypt(): Promise<{ handles: Uint8Array[]; inputProof: Uint8Array }>;
}

let instancePromise: Promise<FheInstance> | null = null;

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
export function getFheInstance(): Promise<FheInstance> {
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
      }) as unknown as FheInstance;
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
 * ARASTIRMACI cozumu — kendisine ACL izni verilmis handle'lari acar.
 *
 * # `publicDecrypt`'ten farki
 *
 * `publicDecrypt` "herkese acik" isaretlenmis degerler icindir. Acilim
 * (`executeDisclosure`) ise izni YALNIZCA arastirmacinin adresine verir
 * (`FHE.allow(handle, researcher)`). O yuzden cozum, arastirmacinin
 * IMZASINI gerektirir: KMS, imzayi dogrulayip izinli olup olmadigina bakar.
 *
 * # Nasil isliyor
 *
 * 1. Tarayicida gecici bir anahtar cifti uretilir — cozulen deger yalnizca
 *    bu anahtarla acilabilir, relayer bile duz metni gormez.
 * 2. Acik anahtar + kontrat listesi + gecerlilik suresi EIP-712 ile
 *    imzalanir; imza kullanicinin cuzdanindan gelir.
 * 3. Relayer, KMS'ten yeniden sifreleme (reencryption) alir ve sonuc gecici
 *    ozel anahtarla acilir.
 *
 * # Relayer'in 2048 BIT siniri
 *
 * Tek istekte cozulebilecek toplam sifreli BIT sayisi 2048'dir. Bizim
 * penceremiz bunu rahatca asiyor:
 *
 *     10 SNP x 2 grup x 3 seviye x euint32          = 1920 bit
 *      6 metrik x 2 grup x (64 + 64 + 32)           = 1920 bit
 *                                             toplam = 3840 bit
 *
 * Bu yuzden istekler bit genisligine gore PARCALANIR. Imza tek kalir:
 * EIP-712 mesaji acik anahtari, kontrat listesini ve sureyi imzalar —
 * HANDLE'LARI DEGIL. Her parti icin ayri imza istemek kullaniciya arka
 * arkaya cuzdan uyarisi gostermek olurdu.
 *
 * @param pairs `{ handle, contractAddress, bits }` ucluleri. Kontrat adresi
 *        SART: ACL kaydi handle+kontrat ikilisine baglidir. `bits`,
 *        parcalamanin dogru yapilabilmesi icin cagirandan gelir — handle'dan
 *        tip cikarmak yerine bilinen tipi tasimak daha az kirilgan.
 * @param signer Izin verilmis adresin imzalayicisi.
 *
 * @returns handle -> duz deger (bigint) eslemesi.
 */
export interface DecryptRequest {
  handle: string;
  contractAddress: string;
  /** Sifreli degerin bit genisligi (euint32 -> 32, euint64 -> 64). */
  bits: number;
}

/** Relayer'in tek istekte cozebilecegi en fazla sifreli bit. */
const MAX_BITS_PER_REQUEST = 2048;

export async function userDecrypt(
  pairs: DecryptRequest[],
  signer: { getAddress(): Promise<string>; signTypedData(d: any, t: any, v: any): Promise<string> },
  onBatch?: (index: number, total: number) => void,
): Promise<Record<string, bigint>> {
  if (pairs.length === 0) return {};

  const instance = await getFheInstance();
  const userAddress = await signer.getAddress();

  const keypair = instance.generateKeypair();

  const contracts = [...new Set(pairs.map((p) => p.contractAddress))];

  // SAYI, metin DEGIL.
  //
  // SDK bu iki alani `UintNumber` olarak dogruluyor; metin verilince
  // `InvalidTypeError undefined UintNumber string` ile duser ve hangi alanin
  // sorunlu oldugunu SOYLEMEZ. Tip bildirimi zaten `number` diyor.
  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = 1;

  const eip712 = instance.createEIP712(
    keypair.publicKey,
    contracts,
    startTimestamp,
    durationDays,
  );

  // EIP712Domain tipi imzalamada YER ALMAZ; ethers onu domain'den turetir.
  // Birakilirsa "ambiguous primary type" hatasi verir.
  const { EIP712Domain: _domain, ...types } = eip712.types as Record<string, unknown>;

  const signature = await signer.signTypedData(
    eip712.domain,
    types as any,
    eip712.message,
  );

  // Bit genisligine gore parcala. Tek bir handle bile siniri asiyorsa yine
  // kendi partisine konur; bolunemeyecegi icin hata relayer'dan gelir ve
  // sessizce yutulmaz.
  const batches: DecryptRequest[][] = [];
  let current: DecryptRequest[] = [];
  let bits = 0;

  for (const pair of pairs) {
    if (current.length > 0 && bits + pair.bits > MAX_BITS_PER_REQUEST) {
      batches.push(current);
      current = [];
      bits = 0;
    }
    current.push(pair);
    bits += pair.bits;
  }
  if (current.length > 0) batches.push(current);

  const out: Record<string, bigint> = {};

  for (const [index, batch] of batches.entries()) {
    onBatch?.(index + 1, batches.length);

    const results = await instance.userDecrypt(
      batch.map((p) => ({ handle: p.handle, contractAddress: p.contractAddress })),
      keypair.privateKey,
      keypair.publicKey,
      signature.replace(/^0x/, ""),
      contracts,
      userAddress,
      startTimestamp,
      durationDays,
    );

    // SDK zarf dondurur; duz degerler `clearValues` ICINDEDIR. Zarfin
    // kendisini dolasmak, handle->deger eslemesi yerine alan adlarini
    // gezmek olurdu.
    const clear = (results as any).clearValues ?? results;
    for (const [handle, value] of Object.entries(clear)) {
      out[handle.toLowerCase()] = BigInt(value as any);
    }
  }

  return out;
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
