/**
 * E-posta dogrulama kodu.
 *
 * Kod sunucuda SAKLANMAZ. Istemciye, icinde kodun anahtarli ozeti bulunan
 * imzali bir "meydan okuma" jetonu verilir; kod e-postayla gider. Kullanici
 * kodu jetonla birlikte geri gonderir. Ozet anahtarsiz hesaplanamadigi icin
 * jetonu elinde tutan biri kodu cikaramaz.
 */
import { createHmac, randomBytes, randomInt } from "node:crypto";

import { signToken, verifyToken } from "./tokens.js";

export const OTP_TTL_SECONDS = 10 * 60;
export const OTP_MAX_ATTEMPTS = 5;

function codeDigest(secret, email, code, nonce) {
  return createHmac("sha256", `otp:${secret}`).update(`${email}|${code}|${nonce}`).digest("base64url");
}

export function createChallenge(secret, email) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const nonce = randomBytes(12).toString("base64url");
  const challenge = signToken(
    secret,
    "otp",
    { email, n: nonce, d: codeDigest(secret, email, code, nonce) },
    OTP_TTL_SECONDS,
  );
  return { code, challenge, nonce };
}

/**
 * Deneme sayaci BELLEKTE tutulur.
 *
 * Sunucu uyuyunca sifirlanir; bu kabul edilebilir cunku kod 10 dakikada
 * doluyor ve servis ancak 15 dakika istek gelmezse uyuyor - yani deneme
 * yapan biri servisi uyanik tutar ve sayac korunur.
 */
const attempts = new Map();

export function verifyChallenge(secret, challenge, code) {
  const payload = verifyToken(secret, challenge, "otp");
  const used = attempts.get(payload.n) ?? 0;
  if (used >= OTP_MAX_ATTEMPTS) throw new Error("cok fazla hatali deneme; yeni kod isteyin");
  attempts.set(payload.n, used + 1);
  if (attempts.size > 50_000) attempts.clear();

  const normalized = String(code ?? "").trim();
  if (!/^\d{6}$/.test(normalized) || codeDigest(secret, payload.email, normalized, payload.n) !== payload.d) {
    throw new Error("kod hatali");
  }
  attempts.delete(payload.n);
  return payload.email;
}
