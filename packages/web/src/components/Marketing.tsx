export function StatRow({ participants }: { participants: number | null }) {
  const items = [
    { value: participants != null ? String(participants) : "—", label: "SIFRELI KATILIMCI" },
    { value: "33+7", label: "ANKET MADDESI" },
    { value: "3", label: "KULLANIM GRUBU" },
  ];
  return (
    <div className="stats section">
      {items.map((it) => (
        <div key={it.label}>
          <div className="stat__value">{it.value}</div>
          <div className="stat__label eyebrow">{it.label}</div>
        </div>
      ))}
    </div>
  );
}

const FEATURES = [
  {
    icon: "◇",
    title: "Duz-metin hatti (referans)",
    body: "Ayni yanitlar acik sekilde toplanir ve klasik yontemle analiz edilir. Bilimsel dogrulugun olcusu budur.",
  },
  {
    icon: "⬡",
    title: "FHE hatti (gizli)",
    body: "Ayni yanitlar sifreli halde toplanir. Kontrat n, Σx ve Σx² degerlerini bireysel puani hic acmadan biriktirir.",
  },
  {
    icon: "=",
    title: "Bit-bit ayni sonuc",
    body: "Iki hat ayni tamsayilari ve ayni p-degerini uretir. Gizlilik icin bilimsel dogruluktan odun verilmiyor.",
  },
];

export function FeatureRow() {
  return (
    <div className="features section">
      {FEATURES.map((f) => (
        <div className="feature" key={f.title}>
          <div className="feature__icon" style={{ background: "var(--color-paper)" }}>
            <span style={{ fontSize: 18 }}>{f.icon}</span>
          </div>
          <h3>{f.title}</h3>
          <p>{f.body}</p>
        </div>
      ))}
    </div>
  );
}

export function SectionHead({
  eyebrow,
  title,
  sub,
}: {
  eyebrow: string;
  title: string;
  sub: string;
}) {
  return (
    <div className="section-head">
      <span className="eyebrow eyebrow--12">{eyebrow}</span>
      <h2>{title}</h2>
      <p>{sub}</p>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="footer section">
      <div className="nav__brand">
        <span className="nav__word">veriarfy</span>
      </div>
      <p className="footer__note">
        ZK ile kimlik · FHE ile veri · Zama FHEVM · Sepolia · Arastirma amaclidir,
        tibbi tani veya tedavi tavsiyesi degildir.
      </p>
    </footer>
  );
}
