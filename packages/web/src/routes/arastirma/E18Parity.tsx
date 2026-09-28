import { useMemo } from "react";
import { buildE18ParityReport, formatP } from "@veriarfy/study";

function fixed(value: number, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function signed(value: number) {
  return `${value > 0 ? "+" : ""}${value.toLocaleString("tr-TR")}`;
}

/**
 * E/18'in sentetik FHE transcript'ini plaintext referansiyla yan yana sunar.
 * Canli Sepolia kohort sonucu degildir: o deployment'ta henuz katilimci veya
 * disclosure snapshot'i yoktur. Bu ayrim, kanit ekraninin test sonucunu canli
 * veri gibi gostermesini engeller.
 */
export function E18Parity() {
  const report = useMemo(() => buildE18ParityReport(), []);
  const association = report.genomic.association;
  const bmi = report.bmi;

  return (
    <section className="e18-parity" aria-labelledby="e18-parity-title">
      <div className="e18-parity__heading">
        <div>
          <span className="eyebrow">E/18 / SENTETIK PARITY</span>
          <h1 id="e18-parity-title">FHE aggregate ile plaintext ayni mi?</h1>
          <p>Kimliksiz, deterministik 60 satirli BMI + tek SNP fixture'i; yalnizca izinli grup toplamlari karsilastirilir.</p>
        </div>
        <span className={`badge ${report.pass ? "badge--ok" : "badge--warn"}`}>{report.pass ? "PASS / Δ=0" : "FAIL"}</span>
      </div>

      <div className="notice notice--warn" role="note">
        Bu ekran canli Sepolia kohort sonucu degil. Sepolia E/18 deployment'i topoloji olarak dogrulandi; henuz 60 sentetik katki ve zincir-ustu disclosure snapshot'i yok.
      </div>

      <article className="e18-parity__evidence card card--bone">
        <div>
          <span className="eyebrow">IMMUTABLE TRANSCRIPT KANITI</span>
          <h2>{report.fixtureId}</h2>
          <p>FHE güvenli handle'larindan çözülen aggregate transcript'i, kontrat testindeki plaintext referansından bağımsız sabit değer olarak tutulur.</p>
        </div>
        <dl className="e18-parity__facts">
          <div><dt>Fixture</dt><dd className="mono">{report.fhe.fixtureId}</dd></div>
          <div><dt>Katılımcı</dt><dd className="mono">{report.fhe.participantCount} / 30 + 30</dd></div>
          <div><dt>Test kanıtı</dt><dd className="mono">E18DisclosurePolicy.test.ts</dd></div>
          <div><dt>Ham handle</dt><dd>decrypt reddi</dd></div>
        </dl>
      </article>

      <article className="research-results__table card">
        <div className="card__head"><h2>SNP 2×3 aggregate</h2><span className="eyebrow">PLAINTEXT / FHE / Δ</span></div>
        <div className="table">
          <div className="table__head table__head--e18"><span>GRUP</span><span>DOZAJ 0</span><span>DOZAJ 1</span><span>DOZAJ 2</span><span>DELTA</span></div>
          {[0, 1].map((group) => (
            <div className="table__row table__row--e18" key={group}>
              <span>{group === 0 ? "Kontrol" : "Vaka"}</span>
              {[0, 1, 2].map((dosage) => <span className="mono" key={dosage}>{report.plaintext.contingency[group][dosage]} / {report.fhe.contingency[group][dosage]}</span>)}
              <span className="mono">[{report.delta.snp[group].map(signed).join(", ")}]</span>
            </div>
          ))}
        </div>
      </article>

      <article className="research-results__table card">
        <div className="card__head"><h2>BMI yeterli istatistikleri</h2><span className="eyebrow">n / Σx / Σx²</span></div>
        <div className="table">
          <div className="table__head table__head--e18-bmi"><span>GRUP</span><span>PLAINTEXT</span><span>FHE TRANSCRIPT</span><span>DELTA</span></div>
          {[0, 1].map((group) => {
            const plain = report.plaintext.bmi[group];
            const fhe = report.fhe.bmi[group];
            const delta = report.delta.bmi[group];
            return <div className="table__row table__row--e18-bmi" key={group}>
              <span>{group === 0 ? "Kontrol" : "Vaka"}</span>
              <span className="mono">{plain.n} / {plain.sum.toLocaleString("tr-TR")} / {plain.sumSq.toLocaleString("tr-TR")}</span>
              <span className="mono">{fhe.n} / {fhe.sum.toLocaleString("tr-TR")} / {fhe.sumSq.toLocaleString("tr-TR")}</span>
              <span className="mono">{signed(delta.n)} / {signed(delta.sum)} / {signed(delta.sumSq)}</span>
            </div>;
          })}
        </div>
      </article>

      <div className="e18-parity__derived">
        <article className="card">
          <span className="eyebrow">TÜRETİLMİŞ GENOMİK ÖZET</span>
          <h2>Association + HWE</h2>
          <dl className="e18-parity__facts">
            <div><dt>Ki-kare / p</dt><dd className="mono">{fixed(association.chiSquare.chi2)} / {formatP(association.chiSquare.p)}</dd></div>
            <div><dt>Allelic OR (%95 GA)</dt><dd className="mono">{fixed(association.oddsRatio.oddsRatio)} ({fixed(association.oddsRatio.ci95[0])}–{fixed(association.oddsRatio.ci95[1])})</dd></div>
            <div><dt>Kontrol HWE p</dt><dd className="mono">{formatP(report.genomic.groups[0].hwe.p)}</dd></div>
            <div><dt>Vaka HWE p</dt><dd className="mono">{formatP(report.genomic.groups[1].hwe.p)}</dd></div>
          </dl>
        </article>
        <article className="card">
          <span className="eyebrow">TÜRETİLMİŞ BMI ÖZETİ</span>
          <h2>Welch t + Cohen d</h2>
          <dl className="e18-parity__facts">
            <div><dt>Kontrol ortalaması</dt><dd className="mono">{fixed(bmi.a.mean / 100)} kg/m²</dd></div>
            <div><dt>Vaka ortalaması</dt><dd className="mono">{fixed(bmi.b.mean / 100)} kg/m²</dd></div>
            <div><dt>Fark / p</dt><dd className="mono">{fixed(bmi.meanDiff / 100)} / {formatP(bmi.p)}</dd></div>
            <div><dt>Cohen d</dt><dd className="mono">{fixed(bmi.cohensD)}</dd></div>
          </dl>
        </article>
      </div>

      <p className="e18-parity__scope">{report.fhe.evidence.scope} {report.fhe.evidence.assertion}</p>
    </section>
  );
}
