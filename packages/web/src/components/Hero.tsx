import { Link } from "react-router-dom";

import { useT } from "../lib/i18n";
import specimenArchive from "../assets/encrypted-specimen-archive.webp";

export function Hero() {
  const t = useT();

  return (
    <header className="hero section">
      <div className="hero__content">
        <p className="hero__context">{t("KİŞİSEL VERİ ARŞİVİ / KAYIT 04–SEPOLIA")}</p>
        {/*
          * Baslik tek parca ceviriliyor, uc parcaya bolunmuyor: vurgulanan
          * kelimenin cumledeki yeri dile gore degisir ("kapali kalir" ->
          * "stays sealed"), parcali ceviri Ingilizcede sirayi bozardi.
          */}
        <h1
          className="hero__title"
          dangerouslySetInnerHTML={{ __html: t("Veri, izin verilene kadar <em>kapalı</em> kalır.") }}
        />
        <p className="hero__sub">{t("Genomik ve biyobelirteç kayıtları cihazınızda şifrelenir. Araştırma isteği yalnızca verdiğiniz izin kapsamına göre çalışır; işlem kaydı sonradan doğrulanabilir.")}</p>
        <div className="hero__actions">
          <Link className="pill pill--primary" to="/giris">{t("Çalışma alanına girin")}</Link>
          <a href="#yontem" className="pill pill--ghost">{t("Kayıt akışını inceleyin")}</a>
        </div>
      </div>
      <div className="hero__archive">
        <figure className="specimen">
          <img src={specimenArchive} alt={t("Mineral dokulu bir laboratuvar lamı üzerinde arşivlenmiş biyolojik numune")} />
          <figcaption className="specimen__label">
            <span className="eyebrow">ACCESSION / VAF–04–781</span>
            <strong>{t("Genomik + biyobelirteç")}</strong>
            <span className="mono">{t("İzin: etkin · kayıt: doğrulanabilir")}</span>
          </figcaption>
        </figure>
        <aside className="hero__evidence" aria-label={t("Veri işleme kanıtları")}>
          <div><span>01</span><p><strong>{t("Yerel şifreleme")}</strong>{t("Ham dosya tarayıcıyı terk etmez.")}</p></div>
          <div><span>02</span><p><strong>{t("İzin kaydı")}</strong>{t("Erişim zincir durumuna bağlıdır.")}</p></div>
          <div><span>03</span><p><strong>{t("Grup sonucu")}</strong>{t("Tekil kayıt açığa çıkmaz.")}</p></div>
        </aside>
      </div>
    </header>
  );
}
