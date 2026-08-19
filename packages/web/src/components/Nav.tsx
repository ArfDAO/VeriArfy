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
      <div className="nav__links">
        <a href="#durum" className="nav__link">Sistem Durumu</a>
        <a href="#katil" className="nav__link">Katıl</a>
        <a href="#sonuclar" className="nav__link">Sonuçlar</a>
      </div>
    </nav>
  );
}
