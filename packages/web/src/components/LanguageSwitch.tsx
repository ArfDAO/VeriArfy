import { useI18n, type Lang } from "../lib/i18n";

const OPTIONS: { value: Lang; short: string; full: string }[] = [
  { value: "tr", short: "TR", full: "Türkçe" },
  { value: "en", short: "EN", full: "İngilizce" },
];

/**
 * Dil secici.
 *
 * @remarks Iki dil oldugu icin acilir liste degil, yan yana iki dugme:
 *          secenek sayisi az oldugunda liste bir tiklama fazladan maliyet
 *          demektir ve mevcut dil gorunmez olur.
 *
 *          Kisaltmalar (TR/EN) gorunur, tam ad ekran okuyucuya gider — iki
 *          harf sesli okunmasi anlamsiz bir etikettir.
 */
export function LanguageSwitch({ className = "" }: { className?: string }) {
  const { lang, setLang, t } = useI18n();

  return (
    <div className={`lang-switch ${className}`.trim()} role="group" aria-label={t("Dil")}>
      {OPTIONS.map((option) => (
        <button
          aria-current={lang === option.value ? "true" : undefined}
          aria-label={t(option.full)}
          className={`lang-switch__option${lang === option.value ? " is-active" : ""}`}
          key={option.value}
          onClick={() => setLang(option.value)}
          type="button"
        >
          {option.short}
        </button>
      ))}
    </div>
  );
}
