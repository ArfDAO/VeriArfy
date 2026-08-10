/**
 * Calisma olcekleri.
 *
 * ANKSIYETE — Burns Anxiety Inventory yapisi:
 *   33 madde, her biri 0–3 (Hic / Biraz / Orta / Cok), toplam 0–99.
 *   Uc alt olcek: Anksiyeteli Duygular (6), Anksiyeteli Dusunceler (11),
 *   Fiziksel Belirtiler (16).
 *
 * ONEMLI (telif): Asagidaki madde metinleri, Burns envanterinin YAPISINI
 * (madde sayisi, alt olcekler, 0–3 puanlama, kesim noktalari) birebir izleyen
 * ozgun Turkce ifadelerdir; Dr. Burns'un telifli madde metinleri degildir.
 * Lisansli tam metne sahipseniz yalnizca bu dosyadaki `text` alanlarini
 * degistirmeniz yeterlidir — puanlama, istatistik ve FHE hatti aynen calisir.
 */

/** Likert secenekleri (0–3). */
export const ANXIETY_CHOICES = [
  { value: 0, label: "Hic" },
  { value: 1, label: "Biraz" },
  { value: 2, label: "Orta" },
  { value: 3, label: "Cok" },
];

export const SUBSCALES = {
  FEELINGS: "Anksiyeteli Duygular",
  THOUGHTS: "Anksiyeteli Dusunceler",
  PHYSICAL: "Fiziksel Belirtiler",
};

/** 33 madde — "Son bir haftada asagidakiler sizi ne kadar rahatsiz etti?" */
export const ANXIETY_ITEMS = [
  // I — Anksiyeteli Duygular (6)
  { id: 1, sub: SUBSCALES.FEELINGS, text: "Kaygi, endise ya da korku hissi" },
  { id: 2, sub: SUBSCALES.FEELINGS, text: "Bir seylerin ters gidecegi sezgisi" },
  { id: 3, sub: SUBSCALES.FEELINGS, text: "Sinirlerin gergin olmasi, gevseyememe" },
  { id: 4, sub: SUBSCALES.FEELINGS, text: "Huzursuzluk, yerinde duramama" },
  { id: 5, sub: SUBSCALES.FEELINGS, text: "Kolayca irkilme ya da urkme" },
  { id: 6, sub: SUBSCALES.FEELINGS, text: "Bir felaket olacakmis gibi dehset duygusu" },

  // II — Anksiyeteli Dusunceler (11)
  { id: 7, sub: SUBSCALES.THOUGHTS, text: "Zihnin surekli mesgul olmasi, dusunceleri durduramama" },
  { id: 8, sub: SUBSCALES.THOUGHTS, text: "Korkutucu goruntu ya da sahnelerin zihinde canlanmasi" },
  { id: 9, sub: SUBSCALES.THOUGHTS, text: "Dikkati toplamakta zorlanma" },
  { id: 10, sub: SUBSCALES.THOUGHTS, text: "Hizlanmis, ucusan dusunceler" },
  { id: 11, sub: SUBSCALES.THOUGHTS, text: "Unutkanlik, hafizada zayiflama" },
  { id: 12, sub: SUBSCALES.THOUGHTS, text: "Karar vermekte zorlanma" },
  { id: 13, sub: SUBSCALES.THOUGHTS, text: "Kontrolu kaybetme korkusu" },
  { id: 14, sub: SUBSCALES.THOUGHTS, text: "Aklini kacirma korkusu" },
  { id: 15, sub: SUBSCALES.THOUGHTS, text: "Bayilma ya da cokme korkusu" },
  { id: 16, sub: SUBSCALES.THOUGHTS, text: "Ciddi bir hastaligi oldugu korkusu" },
  { id: 17, sub: SUBSCALES.THOUGHTS, text: "Baskalarinin olumsuz degerlendirmesinden korkma" },

  // III — Fiziksel Belirtiler (16)
  { id: 18, sub: SUBSCALES.PHYSICAL, text: "Kalbin hizli, guclu ya da duzensiz carpmasi" },
  { id: 19, sub: SUBSCALES.PHYSICAL, text: "Goguste agri ya da baski" },
  { id: 20, sub: SUBSCALES.PHYSICAL, text: "El ya da ayak parmaklarinda karincalanma/uyusma" },
  { id: 21, sub: SUBSCALES.PHYSICAL, text: "Mide rahatsizligi ya da bulanti" },
  { id: 22, sub: SUBSCALES.PHYSICAL, text: "Kabizlik ya da ishal" },
  { id: 23, sub: SUBSCALES.PHYSICAL, text: "Kaslarda seyirme ya da gerginlik" },
  { id: 24, sub: SUBSCALES.PHYSICAL, text: "Titreme ya da sarsilma" },
  { id: 25, sub: SUBSCALES.PHYSICAL, text: "Halsizlik, bacaklarda gucsuzluk" },
  { id: 26, sub: SUBSCALES.PHYSICAL, text: "Bas donmesi, sersemlik hissi" },
  { id: 27, sub: SUBSCALES.PHYSICAL, text: "Nefes darligi, yeterince hava alamama" },
  { id: 28, sub: SUBSCALES.PHYSICAL, text: "Bas agrisi, boyun ya da sirt gerginligi" },
  { id: 29, sub: SUBSCALES.PHYSICAL, text: "Sicak basmasi ya da usume nobetleri" },
  { id: 30, sub: SUBSCALES.PHYSICAL, text: "Sicaktan kaynaklanmayan terleme" },
  { id: 31, sub: SUBSCALES.PHYSICAL, text: "Bogazda dugum hissi, yutkunma guclugu" },
  { id: 32, sub: SUBSCALES.PHYSICAL, text: "Uykuya dalma ya da uykuyu surdurme sorunu" },
  { id: 33, sub: SUBSCALES.PHYSICAL, text: "Kendini ya da cevreyi gercek disi hissetme" },
];

export const ANXIETY_MAX = ANXIETY_ITEMS.length * 3; // 99

/** Burns kesim noktalari (0–99). */
export const ANXIETY_BANDS = [
  { min: 0, max: 4, label: "Minimal ya da anksiyete yok" },
  { min: 5, max: 10, label: "Sinirda anksiyete" },
  { min: 11, max: 20, label: "Hafif anksiyete" },
  { min: 21, max: 30, label: "Orta duzey anksiyete" },
  { min: 31, max: 50, label: "Siddetli anksiyete" },
  { min: 51, max: 99, label: "Asiri anksiyete ya da panik" },
];

export function anxietyBand(score) {
  return ANXIETY_BANDS.find((b) => score >= b.min && score <= b.max)?.label ?? "—";
}

/**
 * PANIK — PDSS (Panic Disorder Severity Scale) yapisinda 7 madde, her biri 0–4.
 * Toplam 0–28. Madde metinleri ozgun Turkce ifadelerdir.
 */
export const PANIC_CHOICES = [
  { value: 0, label: "Yok" },
  { value: 1, label: "Hafif" },
  { value: 2, label: "Orta" },
  { value: 3, label: "Siddetli" },
  { value: 4, label: "Asiri" },
];

export const PANIC_ITEMS = [
  { id: 1, text: "Son bir haftada panik atak sikligi" },
  { id: 2, text: "Ataklar sirasinda yasanan sikinti duzeyi" },
  { id: 3, text: "Yeni bir atak gelecegi endisesi (beklenti anksiyetesi)" },
  { id: 4, text: "Atak korkusuyla yer ya da durumlardan kacinma" },
  { id: 5, text: "Bedensel duyumlari tetikleyen etkinliklerden kacinma" },
  { id: 6, text: "Is ya da sorumluluklarda bozulma" },
  { id: 7, text: "Sosyal yasamda bozulma" },
];

export const PANIC_MAX = PANIC_ITEMS.length * 4; // 28

/**
 * MARUZIYET — gunluk sosyal medya kullanimi.
 * Calismanin birincil karsilastirmasi: DUSUK (0) ile YUKSEK (2) arasi.
 */
export const USAGE_GROUPS = [
  { id: 0, label: "0–5 saat", short: "DUSUK", color: "var(--color-mint)" },
  { id: 1, label: "5–10 saat", short: "ORTA", color: "var(--color-meringue)" },
  { id: 2, label: "10+ saat", short: "YUKSEK", color: "var(--color-iris)" },
];

export const GROUP_COUNT = USAGE_GROUPS.length;

/** Birincil karsilastirma: dusuk kullanim vs yuksek kullanim. */
export const PRIMARY_CONTRAST = { a: 0, b: 2 };

export const USAGE_QUESTION =
  "Gunde ortalama ne kadar sure sosyal medya kullaniyorsunuz?";
