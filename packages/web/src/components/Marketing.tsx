export function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) {
  return <div className="section-head"><p className="section-head__context">{eyebrow}</p><h2>{title}</h2><p>{sub}</p></div>;
}

export function StatRow({ participants }: { participants: number | null }) {
  return <section className="section stats" aria-label="Çalışma kapsamı"><div className="stats__item"><strong className="mono">{participants ?? "—"}</strong><span>Katılımcı kaydı</span></div><div className="stats__item"><strong className="mono">12</strong><span>Çalışma sorusu</span></div><div className="stats__item"><strong className="mono">2</strong><span>Hesaplama yolu</span></div></section>;
}

export function FeatureRow() {
  return <div className="archive-flow" id="yontem">
    <article className="archive-flow__owner"><span className="mono">01 / VERİ SAHİBİ</span><h3>Kişisel kaydı hazırlayın.</h3><p>Dosya uyumu görülür, alanlar yerelde şifrelenir ve izin kaydı oluşur.</p><div className="archive-flow__ledger"><span>İzin kaydı</span><span className="mono">ACTIVE</span><span>Alan kapsamı</span><span className="mono">12 / 12</span></div></article>
    <article className="archive-flow__research"><span className="mono">02 / ARAŞTIRMACI</span><h3>Çalışma protokolünü tanımlayın.</h3><p>Yalnız gerekli alanlar ve sonuç koşulları kayda alınır; talep bir çalışma nesnesi olarak ilerler.</p></article>
    <article className="archive-flow__node"><span className="mono">03 / DOĞRULAMA DÜĞÜMÜ</span><h3>İşlem defterini denetleyin.</h3><p>Onay, itiraz penceresi ve çözüm sırası tek bir denetlenebilir kayıtta tutulur.</p><div className="archive-flow__ledger"><span>Onay durumu</span><span className="mono">PENDING</span><span>Kanıt yolu</span><span className="mono">0x7C…A11</span></div></article>
  </div>;
}

export function Footer() {
  return <footer className="footer"><div className="section footer__content"><p>VeriArfy araştırma amaçlıdır; tıbbi değerlendirme veya tavsiye sunmaz.</p><p className="mono">FHE · ZK · SEPOLIA</p></div></footer>;
}
