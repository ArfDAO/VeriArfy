export function Hero() {
  return (
    <header className="hero section">
      <div className="hero__wave">
        <svg viewBox="0 0 900 200" fill="none">
          <path d="M0 80 Q225 20 450 80 T900 80 V200 H0Z" fill="#c094e4" opacity="0.18" />
          <path d="M0 100 Q225 50 450 100 T900 100 V200 H0Z" fill="#f7bbe6" opacity="0.15" />
          <path d="M0 120 Q225 70 450 120 T900 120 V200 H0Z" fill="#ffb760" opacity="0.12" />
        </svg>
      </div>
      
      <div className="hero__content">
        <span className="eyebrow" style={{ marginBottom: 24, display: "inline-block" }}>
          ZAMA CONCRETE ML · FHE
        </span>
        <h1 className="hero__title">
          Sosyal medya kaygıyı artırıyor mu?
        </h1>
        <p className="hero__sub">
          Gerçek kullanıcı verisiyle şifreli makine öğrenimi doğruluğunu test ediyoruz. Cevaplarınız FHE ile şifrelenir ve şifreli halde tahmin yapılır.
        </p>
        <div className="hero__actions" style={{ marginTop: 40, display: 'flex', gap: 16, justifyContent: 'center' }}>
          <a href="#anket" className="pill pill--primary">Ankete Katıl</a>
          <a href="#sonuclar" className="pill pill--ghost">Sonuçları Gör</a>
        </div>
      </div>
    </header>
  );
}
