/**
 * Kurum e-postasi ve kimlik ozetleri.
 *
 * Saf fonksiyonlar: ag cagrisi yok, dogrudan test edilir.
 */
import { createHmac } from "node:crypto";

/**
 * Ogrenci adreslerinde yaygin alt alan adlari.
 *
 * Bircok universite ogrencilere de edu.tr adresi veriyor. Bazilari bunu ayri
 * bir alt alan adiyla yapiyor (ogr.xxx.edu.tr); bunlari burada ayiklamak
 * YALNIZCA bir on elemedir. Akademik durumu belirleyen asil kontrol ORCID ya
 * da YOK Akademik adimidir - ogrencilerine ana alan adini veren bir
 * universitede bu liste hicbir sey yakalamaz.
 */
const STUDENT_SUBDOMAINS = new Set(["ogr", "ogrenci", "student", "students", "stu"]);

/**
 * E-postayi karsilastirilabilir tek bir bicime getirir.
 *
 * "+etiket" kismi atilir: bircok posta sunucusu `ad+x@` adresini `ad@` kutusuna
 * teslim eder. Atilmasaydi ayni kisi `ad+1@`, `ad+2@` ile sinirsiz kimlik
 * acabilirdi ve tekillik kurali anlamini yitirirdi.
 */
export function normalizeEmail(raw) {
  if (typeof raw !== "string") throw new Error("e-posta metin olmali");
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) throw new Error("gecersiz e-posta adresi");

  let local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);

  if (!/^[a-z0-9._-]+$/.test(local)) throw new Error("gecersiz e-posta adresi");
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.includes("..")) throw new Error("gecersiz e-posta adresi");

  return `${local}@${domain}`;
}

/**
 * Adresin bir Turk yuksekogretim kurumuna ait olup olmadigini kontrol eder ve
 * kurumun alan adini dondurur (ornek: `ogr.erciyes.edu.tr` -> `erciyes.edu.tr`).
 */
export function academicDomain(email) {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const labels = domain.split(".");
  if (labels.length < 3 || labels.at(-1) !== "tr" || labels.at(-2) !== "edu") {
    throw new Error("yalnizca kurum e-postalari (.edu.tr) kabul edilir");
  }
  const sub = labels.slice(0, -3);
  if (sub.some((label) => STUDENT_SUBDOMAINS.has(label))) {
    throw new Error("ogrenci e-posta adresleri arastirmaci dogrulamasinda kullanilamaz");
  }
  return labels.slice(-3).join(".");
}

/**
 * Zincire yazilacak kimlik ozeti: HMAC(gizli anahtar, tur:deger).
 *
 * Duz bir hash burada yetmezdi: kurum e-posta adresleri tahmin edilebilir
 * (ad.soyad@universite.edu.tr) ve deneme yoluyla ozetten geri bulunurdu.
 * Anahtarsiz HMAC ters cevrilemez.
 *
 * Anahtar DEGISMEMELI: degisirse eski ozetlerle eslesme kaybolur ve tekillik
 * kurali sessizce delinir.
 */
export function identityKey(secret, kind, value) {
  if (!secret || secret.length < 32) throw new Error("kimlik anahtari en az 32 karakter olmali");
  return `0x${createHmac("sha256", secret).update(`${kind}:${value}`).digest("hex")}`;
}
