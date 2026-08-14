export function SectionHead({ eyebrow, title, sub }: { eyebrow: string, title: string, sub: string }) {
  return (
    <div style={{ textAlign: "center", marginBottom: 48 }}>
      <span className="eyebrow">{eyebrow}</span>
      <h2 style={{ fontSize: 32, margin: "16px 0", letterSpacing: "-0.02em" }}>{title}</h2>
      <p style={{ color: "var(--color-smoke)", maxWidth: 500, margin: "0 auto", lineHeight: 1.5 }}>
        {sub}
      </p>
    </div>
  );
}

export function StatRow({ participants }: { participants: number | null }) {
  return (
    <div className="section" style={{ display: "flex", gap: 24, justifyContent: "center", flexWrap: "wrap", margin: "48px auto" }}>
      <div className="card" style={{ padding: "24px 32px", textAlign: "center", minWidth: 200 }}>
        <div className="mono" style={{ fontSize: 32, marginBottom: 8 }}>{participants ?? "—"}</div>
        <div className="eyebrow">Katılımcı</div>
      </div>
      <div className="card" style={{ padding: "24px 32px", textAlign: "center", minWidth: 200 }}>
        <div className="mono" style={{ fontSize: 32, marginBottom: 8 }}>12</div>
        <div className="eyebrow">Anket Sorusu</div>
      </div>
      <div className="card" style={{ padding: "24px 32px", textAlign: "center", minWidth: 200 }}>
        <div className="mono" style={{ fontSize: 32, marginBottom: 8 }}>2</div>
        <div className="eyebrow">ML Modeli (Plain + FHE)</div>
      </div>
    </div>
  );
}

export function FeatureRow() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 24 }}>
      <div className="card">
        <div style={{ fontSize: 32, marginBottom: 16 }}>📊</div>
        <h3 style={{ fontSize: 18, marginBottom: 8 }}>Sentetik Eğitim</h3>
        <p style={{ color: "var(--color-smoke)", fontSize: 14, lineHeight: 1.5 }}>
          1000 kişilik sahte veri ile eğitilen model, gerçek kullanıcı cevaplarını tahmin eder.
        </p>
      </div>
      <div className="card">
        <div style={{ fontSize: 32, marginBottom: 16 }}>🔒</div>
        <h3 style={{ fontSize: 18, marginBottom: 8 }}>FHE Şifreleme</h3>
        <p style={{ color: "var(--color-smoke)", fontSize: 14, lineHeight: 1.5 }}>
          Zama Concrete ML ile cevaplarınız şifrelenir. Model kör kutu içinde tahmin yapar.
        </p>
      </div>
      <div className="card">
        <div style={{ fontSize: 32, marginBottom: 16 }}>⚖️</div>
        <h3 style={{ fontSize: 18, marginBottom: 8 }}>Doğruluk Karşılaştırması</h3>
        <p style={{ color: "var(--color-smoke)", fontSize: 14, lineHeight: 1.5 }}>
          Şifreli ve şifresiz modelin doğruluğu yan yana gösterilir.
        </p>
      </div>
    </div>
  );
}

export function Footer() {
  return (
    <footer style={{ borderTop: "1px solid rgba(34,34,34,0.1)", padding: "32px 0", marginTop: 64 }}>
      <div className="section" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
        <div style={{ color: "var(--color-smoke)", fontSize: 13 }}>
          VeriArfy · Araştırma amaçlıdır, tıbbi tavsiye değildir.
        </div>
        <div className="tag" style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--color-bone)" }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--color-iris)" }} />
          <span className="mono" style={{ fontSize: 11 }}>FHE POWERED</span>
        </div>
      </div>
    </footer>
  );
}
