import { useT } from "../lib/i18n";

export function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) {
  // Metinler cagiran tarafta cevriliyor: bu bilesen bicimlendirmeden sorumlu,
  // icerikten degil.
  return <div className="section-head"><p className="section-head__context">{eyebrow}</p><h2>{title}</h2><p>{sub}</p></div>;
}

export function StatRow({ participants }: { participants: number | null }) {
  const t = useT();
  return (
    <section className="section stats" aria-label={t("Çalışma kapsamı")}>
      <div className="stats__item"><strong className="mono">{participants ?? "—"}</strong><span>{t("Katılımcı kaydı")}</span></div>
      <div className="stats__item"><strong className="mono">12</strong><span>{t("Çalışma sorusu")}</span></div>
      <div className="stats__item"><strong className="mono">2</strong><span>{t("Hesaplama yolu")}</span></div>
    </section>
  );
}

export function FeatureRow() {
  const t = useT();
  return (
    <div className="archive-flow" id="yontem">
      <article className="archive-flow__owner">
        <span className="mono">{t("01 / VERİ SAHİBİ")}</span>
        <h3>{t("Kişisel kaydı hazırlayın.")}</h3>
        <p>{t("Dosya uyumu görülür, alanlar yerelde şifrelenir ve izin kaydı oluşur.")}</p>
        <div className="archive-flow__ledger">
          <span>{t("İzin kaydı")}</span><span className="mono">ACTIVE</span>
          <span>{t("Alan kapsamı")}</span><span className="mono">12 / 12</span>
        </div>
      </article>
      <article className="archive-flow__research">
        <span className="mono">{t("02 / ARAŞTIRMACI")}</span>
        <h3>{t("Çalışma protokolünü tanımlayın.")}</h3>
        <p>{t("Yalnız gerekli alanlar ve sonuç koşulları kayda alınır; talep bir çalışma nesnesi olarak ilerler.")}</p>
      </article>
      <article className="archive-flow__node">
        <span className="mono">{t("03 / DOĞRULAMA DÜĞÜMÜ")}</span>
        <h3>{t("İşlem defterini denetleyin.")}</h3>
        <p>{t("Onay, itiraz penceresi ve çözüm sırası tek bir denetlenebilir kayıtta tutulur.")}</p>
        <div className="archive-flow__ledger">
          <span>{t("Onay durumu")}</span><span className="mono">PENDING</span>
          <span>{t("Kanıt yolu")}</span><span className="mono">0x7C…A11</span>
        </div>
      </article>
    </div>
  );
}

export function Footer() {
  const t = useT();
  return <footer className="footer"><div className="section footer__content"><p>{t("VeriArfy araştırma amaçlıdır; tıbbi değerlendirme veya tavsiye sunmaz.")}</p><p className="mono">FHE · ZK · SEPOLIA</p></div></footer>;
}
