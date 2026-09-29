/**
 * Kurator servisi istemcisi.
 *
 * Kurator, akredite katilimci taahhutlerinin Merkle agacini tutar ve
 * kanit uretmek icin gereken yolu (siblings + pathIndices) verir.
 * Gizli anahtarlari ASLA gormez — yalnizca acik taahhudu (commitment) bilir.
 */
import { CURATOR_URL } from "../config";

export interface MerklePath {
  siblings: string[];
  pathIndices: number[];
  root: string;
  index: number;
}

async function call(path: string, init?: RequestInit) {
  let res: Response;
  try {
    res = await fetch(`${CURATOR_URL}${path}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });
  } catch (reason) {
    // AYRI BIR HATA OLMAK ZORUNDA.
    //
    // Ulasilamayan kurator, tarayicida "Failed to fetch" verir. O metin
    // `userError` icindeki ag kalibina takiliyor ve kullaniciya "Sepolia
    // agini ve RPC baglantinizi kontrol edin" deniyordu — oysa Sepolia
    // gayet calisiyor, eksik olan YEREL kurator servisi. Yanlis tarafa
    // arattiran bir hata mesaji, hata mesaji olmamasindan daha kotudur.
    // `{ cause }` kullanilmiyor: tsconfig ES2021 hedefliyor ve `Error.cause`
    // ES2022. Sebep metne katiliyor — zaten kullanicinin kopyalayip
    // gonderdigi sey gorunen mesaj oluyor.
    const detail = reason instanceof Error ? reason.message : String(reason);
    throw new Error(
      `Kurator servisine ulasilamadi (${CURATOR_URL}). ` +
        `Servisi baslatin: npm run curator [${detail}]`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Kurator hatasi (${res.status}): ${body || res.statusText}`);
  }
  return res.json();
}

export interface EnrollResult {
  index: number;
  root: string;
  /**
   * Kurator taahhudu ekledi ama kokU zincire YAZAMADI.
   *
   * Kurator servisinde `CURATOR_PRIVATE_KEY` tanimliysa kok yazimi otomatiktir
   * ve bu alan `false` doner. `true` dondugunde eksik olan kullanicinin yaptigi
   * bir sey degil, operator tarafindaki yetki; arayuz bunu boyle anlatmali.
   * Eski kurator surumleri alani hic dondurmez, bu yuzden `undefined` olabilir.
   */
  rootPending?: boolean;
}

/** Taahhudu akredite agaca eklet. */
export async function enroll(commitment: bigint): Promise<EnrollResult> {
  return call("/enroll", {
    method: "POST",
    body: JSON.stringify({ commitment: commitment.toString() }),
  });
}

/** Kanit icin Merkle yolunu al. */
export async function getMerklePath(commitment: bigint): Promise<MerklePath> {
  return call(`/path/${commitment.toString()}`);
}

/** Kuratorun bildirdigi guncel kok. */
export async function getRoot(): Promise<string> {
  const { root } = await call("/root");
  return root;
}

export interface CuratorStatus {
  root: string;
  size: number;
  /** Kuratorun zincirden okudugu kok; okuyamazsa null. */
  chainRoot: string | null;
  /** Kurator kokU kendisi yazabiliyor mu (anahtar tanimli mi). */
  autoPush: boolean;
}

/** Kurator + zincir kok durumunu birlikte al. */
export async function getStatus(): Promise<CuratorStatus> {
  const body = await call("/root");
  return {
    root: String(body.root),
    size: Number(body.size ?? 0),
    chainRoot: body.chainRoot == null ? null : String(body.chainRoot),
    autoPush: Boolean(body.autoPush),
  };
}
