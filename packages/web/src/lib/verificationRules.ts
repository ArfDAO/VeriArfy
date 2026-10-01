/**
 * Arastirmaci dogrulamasinin giris kurallari - tarayici kopyasi.
 *
 * Asil kurallar kuratorde (packages/curator/src/verification/identity.js ve
 * profile.js). Onizleme ekrani gercek akisin hangi adresleri kabul edip
 * hangilerini reddettigini gostersin diye ayni kurallar burada da var; iki
 * taraf ayrisirsa onizleme gercek akistan farkli davranir. Degisiklik iki
 * yerde birden yapilmali.
 */

const STUDENT_SUBDOMAINS = new Set(["ogr", "ogrenci", "student", "students", "stu"]);

/** `+etiket` atilir; ayni kutu ikinci kimlik acamasin. */
export function normalizeEmail(raw: string): string {
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

/** Kurumun alan adini dondurur (`ogr.x.edu.tr` reddedilir, `tip.x.edu.tr` -> `x.edu.tr`). */
export function academicDomain(email: string): string {
  const labels = email.slice(email.lastIndexOf("@") + 1).split(".");
  if (labels.length < 3 || labels[labels.length - 1] !== "tr" || labels[labels.length - 2] !== "edu") {
    throw new Error("yalnizca kurum e-postalari (.edu.tr) kabul edilir");
  }
  if (labels.slice(0, -3).some((label) => STUDENT_SUBDOMAINS.has(label))) {
    throw new Error("ogrenci e-posta adresleri arastirmaci dogrulamasinda kullanilamaz");
  }
  return labels.slice(-3).join(".");
}

export function profileSource(raw: string): { url: string; source: "YOK Akademik" | "AVESIS" } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("gecersiz profil adresi");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("gecersiz profil adresi");
  const host = url.hostname.toLowerCase();
  const yok = host === "akademik.yok.gov.tr";
  const avesis = /^avesis\.[a-z0-9-]+\.edu\.tr$/.test(host);
  if (!yok && !avesis) throw new Error("yalnizca YOK Akademik ya da AVESIS profilleri kabul edilir");
  url.protocol = "https:";
  url.hash = "";
  return { url: url.toString(), source: yok ? "YOK Akademik" : "AVESIS" };
}
