import { Link } from "react-router-dom";

export function Hero() {
  return (
    <header className="hero section">
      <div className="hero__content">
        <p className="hero__context">Gizliliği koruyan biyomedikal araştırma altyapısı</p>
        <h1 className="hero__title">Veriniz üzerinde söz hakkınız kalırken araştırmaya katkı verin.</h1>
        <p className="hero__sub">
          VeriArfy, genomik ve biyobelirteç verilerini cihazınızda şifreler. Araştırmacılar yalnızca
          protokolün izin verdiği grup sonuçlarına erişir; katkınız ve işlem durumu zincirden doğrulanır.
        </p>
        <div className="hero__actions">
          <Link className="pill pill--primary" to="/giris">Çalışma alanına girin</Link>
          <a href="#yontem" className="pill pill--ghost">Yöntemi inceleyin</a>
        </div>
      </div>
      <aside className="hero__evidence" aria-label="Veri işleme güvenceleri">
        <div>
          <span>01</span>
          <strong>Yerel şifreleme</strong>
          <p>Ham dosya tarayıcınızı terk etmez.</p>
        </div>
        <div>
          <span>02</span>
          <strong>Doğrulanabilir izin</strong>
          <p>Araştırmacı erişimi zincir durumuna bağlıdır.</p>
        </div>
        <div>
          <span>03</span>
          <strong>Grup düzeyi sonuç</strong>
          <p>Çözüm, onay ve itiraz kurallarından geçer.</p>
        </div>
      </aside>
    </header>
  );
}
