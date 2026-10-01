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

/**
 * Kurator cagrisi icin zaman asimi.
 *
 * Barindirilan servis hareketsizlikte uyutuluyor ve ilk istek uyanmayi
 * bekliyor - olculen sure ~35 saniye. Bu yuzden sinir comert; erken kesmek
 * calisan bir servisi kapali gibi gosterirdi.
 *
 * Ama sinirsiz da birakilamaz: zaman asimi yokken servis tamamen kapali
 * oldugunda istek SONSUZA KADAR asili kaliyor, dugme "Isleniyor..." yaziyor
 * ve kullaniciya hicbir sey soylenmiyordu.
 */
const CURATOR_TIMEOUT_MS = 90_000;

/** Bu sureden uzun suren cagri "servis uyaniyor" demektir. */
export const CURATOR_SLOW_MS = 3_000;

async function call(path: string, init?: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CURATOR_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${CURATOR_URL}${path}`, {
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      ...init,
    });
  } catch (reason) {
    if (reason instanceof Error && reason.name === "AbortError") {
      throw new Error(
        `Kurator servisi ${CURATOR_TIMEOUT_MS / 1000} saniye icinde yanit vermedi ` +
          `(${CURATOR_URL}). Servis kapali olabilir; birazdan yeniden deneyin.`,
      );
    }
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
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // Sunucu ULASILABILIR ve bir hata dondurdu - bu, ulasilamamaktan farkli.
    // Dogrulama uclari kullaniciya yonelik, anlamli mesajlar donduruyor ("kod
    // hatali", "bu e-posta zaten kullanilmis"); bunlar oldugu gibi gosterilir.
    const text = await res.text().catch(() => "");
    let message = text || res.statusText;
    try {
      message = JSON.parse(text).error ?? message;
    } catch {
      /* JSON degil; metin oldugu gibi kalir */
    }
    throw new CuratorResponseError(message, res.status);
  }
  return res.json();
}

/** Kurator yanit verdi ama istegi reddetti. Mesaj kullaniciya gosterilebilir. */
export class CuratorResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CuratorResponseError";
  }
}

export interface EnrollResult {
  index: number;
  root: string;
  /** Taahhut eklendi ama kok zincire yazilamadi. */
  rootPending?: boolean;
}

/**
 * Taahhudu DOGRULAMASIZ olarak listeye ekletir (acik kayit).
 *
 * Yalnizca test aginda, dogrulama yapilandirilana kadar calisir; sonrasinda
 * kurator 410 doner. Bu kayitlar dogrulanmis listeye yazilmaz.
 */
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
  /** Dogrulamasiz (acik) kayit su an etkin mi. */
  openEnrollment: boolean;
  /** Hangi dogrulama yollari yapilandirilmis. */
  verification: VerificationStatus;
}

/** Kurator + zincir kok durumunu birlikte al. */
export async function getStatus(): Promise<CuratorStatus> {
  const body = await call("/root");
  return {
    root: String(body.root),
    size: Number(body.size ?? 0),
    chainRoot: body.chainRoot == null ? null : String(body.chainRoot),
    autoPush: Boolean(body.autoPush),
    openEnrollment: Boolean(body.openEnrollment),
    verification: {
      email: Boolean(body.verification?.email),
      orcid: Boolean(body.verification?.orcid),
      profile: Boolean(body.verification?.profile),
    },
  };
}

/* ---------------------------------------------------------------------------
 * Arastirmaci dogrulamasi
 *
 * Akredite listeye artik dogrudan eklenilemiyor; kurum e-postasi ve ORCID ya da
 * YOK Akademik / AVESIS profiliyle dogrulama gerekiyor. Her adimin sonucu
 * sunucunun imzaladigi bir jeton; sunucu durum tutmuyor.
 * ------------------------------------------------------------------------- */

export interface VerificationStatus {
  email: boolean;
  orcid: boolean;
  profile: boolean;
}

export async function verificationStatus(): Promise<VerificationStatus> {
  return call("/verify/status");
}

export async function startEmailVerification(
  email: string,
): Promise<{ challenge: string; domain: string; expiresIn: number }> {
  return call("/verify/email/start", { method: "POST", body: JSON.stringify({ email }) });
}

export async function confirmEmailVerification(
  challenge: string,
  code: string,
): Promise<{ emailSession: string; email: string; domain: string }> {
  return call("/verify/email/confirm", { method: "POST", body: JSON.stringify({ challenge, code }) });
}

/** ORCID giris adresini dondurur; tarayici oraya yonlendirilir. */
export async function startOrcidVerification(emailSession: string, commitment: bigint): Promise<string> {
  const { url } = await call("/verify/orcid/start", {
    method: "POST",
    body: JSON.stringify({ emailSession, commitment: commitment.toString() }),
  });
  return url;
}

export async function submitProfileForReview(
  emailSession: string,
  commitment: bigint,
  profileUrl: string,
): Promise<void> {
  await call("/verify/profile/submit", {
    method: "POST",
    body: JSON.stringify({ emailSession, commitment: commitment.toString(), profileUrl }),
  });
}

/** Taahhut akredite listede mi? */
export async function isAccredited(commitment: bigint): Promise<boolean> {
  try {
    await call(`/path/${commitment.toString()}`);
    return true;
  } catch (error) {
    if (error instanceof CuratorResponseError && error.status === 404) return false;
    throw error;
  }
}
