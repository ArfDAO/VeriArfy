import { Link } from "react-router-dom";
import specimenArchive from "../assets/encrypted-specimen-archive.webp";

export function Hero() {
  return (
    <header className="hero section">
      <div className="hero__content">
        <p className="hero__context">KİŞİSEL VERİ ARŞİVİ / KAYIT 04–SEPOLIA</p>
        <h1 className="hero__title">Veri, izin verilene kadar <em>kapalı</em> kalır.</h1>
        <p className="hero__sub">Genomik ve biyobelirteç kayıtları cihazınızda şifrelenir. Araştırma isteği yalnızca verdiğiniz izin kapsamına göre çalışır; işlem kaydı sonradan doğrulanabilir.</p>
        <div className="hero__actions"><Link className="pill pill--primary" to="/giris">Çalışma alanına girin</Link><a href="#yontem" className="pill pill--ghost">Kayıt akışını inceleyin</a></div>
      </div>
      <div className="hero__archive">
        <figure className="specimen">
          <img src={specimenArchive} alt="Mineral dokulu bir laboratuvar lamı üzerinde arşivlenmiş biyolojik numune" />
          <figcaption className="specimen__label"><span className="eyebrow">ACCESSION / VAF–04–781</span><strong>Genomik + biyobelirteç</strong><span className="mono">İzin: etkin · kayıt: doğrulanabilir</span></figcaption>
        </figure>
        <aside className="hero__evidence" aria-label="Veri işleme kanıtları">
          <div><span>01</span><p><strong>Yerel şifreleme</strong>Ham dosya tarayıcıyı terk etmez.</p></div>
          <div><span>02</span><p><strong>İzin kaydı</strong>Erişim zincir durumuna bağlıdır.</p></div>
          <div><span>03</span><p><strong>Grup sonucu</strong>Tekil kayıt açığa çıkmaz.</p></div>
        </aside>
      </div>
    </header>
  );
}
