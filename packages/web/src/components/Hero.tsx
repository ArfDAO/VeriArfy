export function Hero() {
  return (
    <header className="hero section">
      <div className="hero__eyebrow eyebrow eyebrow--12">
        ACIK CALISMA · FHE · ZERO-KNOWLEDGE · SEPOLIA
      </div>
      <h1>
        Sosyal medya kullanimi{" "}
        <span className="gradient-text">anksiyeteyi</span> artiriyor mu?
      </h1>
      <p className="hero__sub">
        Gunde 0–5 saat kullananlarla 10+ saat kullananlar arasindaki farki
        olcuyoruz. Yanitlariniz cihazinizda sifrelenir; yalnizca grup
        ortalamalari acilir, bireysel puaniniz asla.
      </p>
      <div className="hero__cta">
        <a className="pill pill--primary" href="#katil">
          Calismaya katil →
        </a>
        <a className="pill pill--ghost" href="#sonuclar">
          Sonuclari gor
        </a>
      </div>

      <div className="hero__wave" aria-hidden>
        <WaveIllustration />
      </div>
    </header>
  );
}

/** Pastel akan dalga cizimi — ses/frekans egrilerini andirir. */
function WaveIllustration() {
  const lines = [
    { color: "#c094e4", phase: 0, amp: 26 },
    { color: "#f7bbe6", phase: 0.8, amp: 20 },
    { color: "#ffb760", phase: 1.6, amp: 32 },
    { color: "#cef1e1", phase: 2.4, amp: 16 },
  ];
  const w = 900;
  const h = 260;
  const mid = h / 2;

  function path(amp: number, phase: number) {
    const pts: string[] = [];
    for (let x = 0; x <= w; x += 12) {
      const y =
        mid +
        Math.sin(x / 70 + phase) * amp +
        Math.sin(x / 180 + phase * 1.7) * (amp * 0.4);
      pts.push(`${x === 0 ? "M" : "L"} ${x} ${y.toFixed(1)}`);
    }
    return pts.join(" ");
  }

  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Pastel dalga cizimi">
      {lines.map((l, i) => (
        <path
          key={i}
          d={path(l.amp, l.phase)}
          fill="none"
          stroke={l.color}
          strokeWidth={2.5}
          strokeLinecap="round"
          opacity={0.9}
        />
      ))}
    </svg>
  );
}
