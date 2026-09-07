import { Link } from "react-router-dom";

import { useT } from "../lib/i18n";
import { LanguageSwitch } from "./LanguageSwitch";

export function Nav() {
  const t = useT();

  return (
    <nav className="nav section">
      <div className="nav__brand">
        <div className="nav__dots">
          <div className="nav__dot"></div>
          <div className="nav__dot"></div>
          <div className="nav__dot"></div>
          <div className="nav__dot"></div>
          <div className="nav__dot"></div>
          <div className="nav__dot"></div>
          <div className="nav__dot"></div>
          <div className="nav__dot"></div>
          <div className="nav__dot"></div>
        </div>
        <span className="nav__word">veriarfy</span>
      </div>
      <div className="nav__actions">
        <div className="nav__links" aria-label={t("Arşiv bölümleri")}>
          <a href="#anket" className="nav__link">{t("Anket")}</a>
          <a href="#sonuclar" className="nav__link">{t("Sonuçlar")}</a>
        </div>
        <span className="nav__divider" aria-hidden="true" />
        {/*
          * Dil secici GIRIS'ten once: dili degistirmek icin once giris yapmak
          * gerekmemeli, ve sag ustteki birincil eylem giris olarak kalmali.
          */}
        <LanguageSwitch />
        <span className="nav__divider" aria-hidden="true" />
        <Link className="pill pill--primary" to="/giris">
          {t("Giriş")}
        </Link>
      </div>
    </nav>
  );
}
