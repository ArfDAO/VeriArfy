/**
 * Yetkili dugum servisini uyandirir.
 *
 * NEDEN GEREKLI: dugum servisi zinciri kendisi tarar ve talepleri kendisi
 * onaylar - ama barindirildigi ortam 15 dakika GELEN trafik olmayinca onu
 * uyutuyor. Uyurken zinciri hic taramiyor. Arastirmaci sorgu actiginda
 * servise hicbir istek gitmedigi icin servis uyumaya devam ediyor ve talep
 * `0/1 onay` olarak bekliyordu; biri tesadufen servise istek atana kadar
 * hicbir sey olmuyordu. Olculen bekleyis 10 dakikanin uzerindeydi.
 *
 * NEDEN ZAMANLANMIS PING DEGIL: ucretsiz katmanin aylik bir calisma saati
 * kotasi var (calisma alani basina 750 saat) ve asildiginda TUM ucretsiz
 * servisler ay sonuna kadar askiya aliniyor. Iki servisi 7/24 uyanik tutmak
 * ~1.440 saat eder; kota ayin ortasinda biter ve kurator de dugum de kapanir.
 * Servis yalnizca kullanici bir sey yaptiginda gerekli; o halde o eylem onu
 * uyandirmali.
 *
 * Cagri "atesle ve unut": sonuc beklenmez, hata kullaniciya yansitilmaz.
 * Uyandirma basarisiz olsa bile sorgu zincirde acilmistir ve servis bir
 * sonraki uyanista onu bulur - tarama olay dinlemez, bekleyen tum talepleri
 * gezer.
 */
import { NODE_OPERATOR_URL } from "../config";

/** Uyanma yaklasik bir dakika suruyor; bu sure boyunca tekrar istek atmanin anlami yok. */
const WAKE_COOLDOWN_MS = 60_000;

let lastWake = 0;

export function wakeNodeOperator(): void {
  const now = Date.now();
  if (now - lastWake < WAKE_COOLDOWN_MS) return;
  lastWake = now;

  // `keepalive`: sayfa bu sirada degisse bile istek gonderilmeye devam eder.
  void fetch(NODE_OPERATOR_URL, { method: "GET", keepalive: true, cache: "no-store" }).catch(() => {
    /* uyandirma en iyi cabadir; basarisizligi kullaniciyi ilgilendirmez */
  });
}

export interface NodeVerdict {
  rejected: { reason: string; at: string } | null;
}

/**
 * Dugum servisinin bir talep icin verdigi karari okur.
 *
 * Reddedilen bir talep zincirde "onay bekliyor" olarak kalir; zincir redde
 * dair bir kayit tutmaz. Sebep yalnizca dugumde bilinir. Bu cagri olmadan
 * arastirmaci neyi bekledigini hicbir zaman ogrenemezdi.
 *
 * Okunamazsa null doner: bu, "reddedilmedi" DEMEK DEGILDIR, "bilinmiyor"dur.
 */
export async function fetchNodeVerdict(requestId: number): Promise<NodeVerdict | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${NODE_OPERATOR_URL}/requests/${requestId}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = await res.json();
    return { rejected: body.rejected ?? null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
