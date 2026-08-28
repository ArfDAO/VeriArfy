import { Link } from "react-router-dom";

export function Nav() {
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
        <div className="nav__links" aria-label="Arşiv bölümleri">
          <a href="#anket" className="nav__link">Anket</a>
          <a href="#sonuclar" className="nav__link">Sonuçlar</a>
        </div>
        <span className="nav__divider" aria-hidden="true" />
        <Link className="pill pill--primary" to="/giris">
          Giriş
        </Link>
      </div>
    </nav>
  );
}
