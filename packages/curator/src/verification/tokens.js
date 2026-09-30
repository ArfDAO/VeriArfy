/**
 * Imzali, suresi dolan jetonlar.
 *
 * NEDEN DURUM TUTMUYORUZ: sunucunun diski kalici degil (her uykuda siliniyor).
 * Dogrulama kodu, e-posta oturumu, ORCID donusu ve operator onayi bu yuzden
 * sunucuda saklanmiyor; icerikleri imzali bir jetonla istemciye veriliyor ve
 * geri geldiginde imza dogrulaniyor. Sunucu yeniden baslasa da akis kopmaz.
 *
 * Her jeton bir `t` (tur) tasir ve yalnizca beklenen turde kabul edilir: bir
 * e-posta oturumu, operator onayi yerine kullanilamamali.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const b64 = (buf) => Buffer.from(buf).toString("base64url");

function mac(secret, body) {
  return createHmac("sha256", `token:${secret}`).update(body).digest();
}

export function signToken(secret, type, payload, ttlSeconds) {
  const body = b64(JSON.stringify({ ...payload, t: type, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  return `${body}.${b64(mac(secret, body))}`;
}

export function verifyToken(secret, token, expectedType) {
  if (typeof token !== "string" || !token.includes(".")) throw new Error("gecersiz jeton");
  const [body, sig] = token.split(".");
  const expected = mac(secret, body);
  const given = Buffer.from(sig ?? "", "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new Error("gecersiz jeton");
  }
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (payload.t !== expectedType) throw new Error("jeton turu uyusmuyor");
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error("jetonun suresi doldu");
  return payload;
}
