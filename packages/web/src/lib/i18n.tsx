/**
 * VeriArfy — dil katmani (TR / EN).
 *
 * ## Neden anahtar degil KAYNAK METIN kullaniliyor
 *
 * Yaygin i18n kurulumu `t("nav.login")` gibi anahtarlar kullanir. Burada
 * cagri `t("Giris")` seklinde, yani anahtar Turkce metnin KENDISIDIR.
 *
 * Sebep bu projeye ozgu: arayuzdeki metinlerin cogu kisa etiket degil, uzun
 * aciklama cumleleri ("Ayrilmak gecmisi silmez. Zaten homomorfik toplamaya
 * karismis veriniz geri cekilemez."). Bunlari `panel.privacy.leaveWarning`
 * gibi anahtarlara tasimak, kodu okuyan kisinin ekranda ne yazdigini
 * gormesini engellerdi — ve bu projede metinler tam olarak neyin
 * kanitlandigini/kanitlanmadigini soyledigi icin okunabilirligi korumak
 * onemli.
 *
 * ## Eksik ceviri EKRANDA GORUNUR
 *
 * Sozlukte karsiligi olmayan metin Turkce haliyle basilir. Sessizce bos
 * string ya da ham anahtar gostermez: eksik ceviri gorunur bir kusurdur ama
 * kirik bir ekran degildir.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

import { EN } from "./locales/en";

export type Lang = "tr" | "en";

const STORAGE_KEY = "veriarfy.lang";

export interface I18nApi {
  lang: Lang;
  setLang(next: Lang): void;
  /**
   * Turkce kaynak metni gecerli dile cevirir.
   *
   * @param params `{ad}` bicimindeki yer tutucular. Cevirinin yer tutucuyu
   *        farkli siraya koymasi serbesttir — dil bilgisi sirasi dillere gore
   *        degisir ve konumsal (`%s`) bir sema bunu imkansiz kilardi.
   */
  t(source: string, params?: Record<string, string | number>): string;
}

const I18nContext = createContext<I18nApi | null>(null);

/** Tarayici depolamasi bazi baglamlarda (gizli sekme, katı gizlilik) patlar. */
function readStored(): Lang | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "tr" || raw === "en" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Ilk dil: once kullanicinin daha onceki secimi, sonra tarayici tercihi.
 *
 * Tarayici Turkce degilse varsayilan Ingilizce olur — yarisma juri ve
 * uluslararasi ziyaretci icin dogru varsayilan budur; Turkce kullanici zaten
 * ilk ziyarette Turkce goruyor.
 */
function detectLang(): Lang {
  const stored = readStored();
  if (stored) return stored;
  if (typeof navigator === "undefined") return "tr";
  return navigator.language?.toLowerCase().startsWith("tr") ? "tr" : "en";
}

function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole,
  );
}

export function I18nProvider({ children }: PropsWithChildren) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  useEffect(() => {
    // `lang` ozniteligi kozmetik degil: ekran okuyucular telaffuzu, tarayici
    // ise tireleme ve ceviri onerisini buna gore secer.
    document.documentElement.lang = lang;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* depolama yoksa secim yalnizca bu oturumda yasar */
    }
  }, [lang]);

  const setLang = useCallback((next: Lang) => setLangState(next), []);

  const t = useCallback(
    (source: string, params?: Record<string, string | number>) => {
      if (lang === "tr") return interpolate(source, params);
      return interpolate(EN[source] ?? source, params);
    },
    [lang],
  );

  const value = useMemo<I18nApi>(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return createElement(I18nContext.Provider, { value }, children);
}

export function useI18n(): I18nApi {
  const api = useContext(I18nContext);
  if (!api) throw new Error("useI18n, I18nProvider icinde kullanilmalidir.");
  return api;
}

/** Yalnizca ceviri fonksiyonu gerekiyorsa kisayol. */
export function useT(): I18nApi["t"] {
  return useI18n().t;
}
