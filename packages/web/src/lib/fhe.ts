/**
 * Tarayici tarafi FHE — Zama Relayer SDK (gercek sifreleme, simulasyon yok).
 *
 * Sifreleme kullanicinin cihazinda yapilir; duz puan hicbir zaman aga cikmaz.
 * Sonuclari okurken yalnizca GRUP DUZEYINDEKI toplamlar herkese acik cozulur.
 */
import { initSDK, createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/web";

let instancePromise: Promise<any> | null = null;

/** SDK'yi bir kez baslatir ve ornegi paylasir. */
export function getFheInstance(): Promise<any> {
  if (!instancePromise) {
    instancePromise = (async () => {
      await initSDK(); // WASM yukler
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
 * Grup duzeyindeki toplamlari herkese acik olarak cozer.
 * @param handles bytes32 handle listesi
 * @returns handle -> duz deger
 */
export async function publicDecrypt(handles: string[]): Promise<Record<string, bigint>> {
  const instance = await getFheInstance();
  const result = await instance.publicDecrypt(handles);
  const out: Record<string, bigint> = {};
  for (const [k, v] of Object.entries(result)) {
    out[k.toLowerCase()] = BigInt(v as any);
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
