/**
 * YOK Akademik / AVESIS profil adresi.
 *
 * YOK Akademik'in resmi bir API'si ya da giris ozelligi yok; bir profilin kime
 * ait oldugu otomatik olarak kanitlanamaz. Bu yol bu yuzden OPERATOR
 * INCELEMESINE gider: profil, dogrulanmis kurum e-postasiyla birlikte
 * operatore gosterilir ve operator eslesmeyi elle onaylar.
 */
export function normalizeProfileUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new Error("gecersiz profil adresi");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("gecersiz profil adresi");
  const host = url.hostname.toLowerCase();

  const yok = host === "akademik.yok.gov.tr";
  // AVESIS her universitenin kendi alan adinda: avesis.<universite>.edu.tr
  const avesis = /^avesis\.[a-z0-9-]+\.edu\.tr$/.test(host);
  if (!yok && !avesis) throw new Error("yalnizca YOK Akademik ya da AVESIS profilleri kabul edilir");

  url.protocol = "https:";
  url.hash = "";
  return { url: url.toString(), source: yok ? "YOK Akademik" : "AVESIS", host };
}
