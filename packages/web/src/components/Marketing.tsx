export function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) {
  return (
    <div className="section-head">
      <p className="section-head__context">{eyebrow}</p>
      <h2>{title}</h2>
      <p>{sub}</p>
    </div>
  );
}

export function StatRow({ participants }: { participants: number | null }) {
  return (
    <section className="section stats" aria-label="Çalışma kapsamı">
      <div className="stats__item">
        <strong className="mono">{participants ?? "—"}</strong>
        <span>Katılımcı kaydı</span>
      </div>
      <div className="stats__item">
        <strong className="mono">12</strong>
        <span>Çalışma sorusu</span>
      </div>
      <div className="stats__item">
        <strong className="mono">2</strong>
        <span>Karşılaştırılan hesaplama yolu</span>
      </div>
    </section>
  );
}

export function FeatureRow() {
  return (
    <div className="method-grid" id="yontem">
      <article className="method-grid__lead">
        <p className="section-head__context">Araştırma protokolü</p>
        <h3>Verinin yaşam döngüsü, her adımda anlaşılır ve denetlenebilir kalır.</h3>
        <p>Katılımcı ne paylaştığını görür. Araştırmacı neye erişebildiğini ve sonucun hangi koşullarda açıldığını takip eder.</p>
      </article>
      <article className="method-grid__item">
        <span className="mono">01</span>
        <h3>Katkıyı hazırlayın</h3>
        <p>Panel uyumu denetlenir; genomik ve biyobelirteç değerleri yerelde şifrelenir.</p>
      </article>
      <article className="method-grid__item">
        <span className="mono">02</span>
        <h3>Sorgu kapsamını belirleyin</h3>
        <p>Araştırmacı yalnız gerekli alanları seçer; ücret ve erişim koşulları işlemden önce görünür.</p>
      </article>
      <article className="method-grid__item">
        <span className="mono">03</span>
        <h3>Sonucu kanıtla ilişkilendirin</h3>
        <p>Yetkili onayı, itiraz penceresi ve çözüm sırası zincirden izlenir.</p>
      </article>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="section footer__content">
        <p>VeriArfy araştırma amaçlıdır; tıbbi değerlendirme veya tavsiye sunmaz.</p>
        <p className="mono">FHE · ZK · SEPOLIA</p>
      </div>
    </footer>
  );
}
