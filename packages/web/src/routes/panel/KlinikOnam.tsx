import { E19_CLINICAL_POLICY, validateE19ClinicalPolicy } from "@veriarfy/study";

const policy = validateE19ClinicalPolicy(E19_CLINICAL_POLICY);

/** Policy receipt, deliberately not a consent action before an E/19 deployment exists. */
export function KlinikOnam() {
  return (
    <section className="clinical-consent" aria-labelledby="clinical-consent-title">
      <div className="clinical-consent__heading">
        <div>
          <span className="eyebrow">E/19 / KLİNİK ONAM SINIRI</span>
          <h1 id="clinical-consent-title">Panel, amaç ve geri çekme açık olmalı</h1>
          <p>Bu ekran bir onam makbuzu taslağıdır; henüz zincire onam veya klinik veri yazmaz.</p>
        </div>
        <span className="badge badge--warn">DEPLOY EDİLMEDİ</span>
      </div>

      <div className="notice notice--warn" role="note">
        Sentetik araştırma prototipidir; klinik karar, ilaç/tedavi önerisi veya gerçek hasta verisi işleme özelliği değildir.
      </div>

      <article className="card card--bone">
        <span className="eyebrow">SABİT KAPSAM</span>
        <h2>CYP2C19 × clopidogrel</h2>
        <p>CPIC’in 2022 kaynak dokümanına bağlı, sürümlenmiş tek panel kimliği. Araştırmacı sadece bu panel ve yalnız aggregate araştırma amacı için uygun olabilir.</p>
        <dl className="clinical-consent__facts">
          <div><dt>Panel</dt><dd className="mono">{policy.panelId}</dd></div>
          <div><dt>Amaç</dt><dd className="mono">{policy.purposeId}</dd></div>
          <div><dt>Onam sürümü</dt><dd className="mono">{policy.consentVersion}</dd></div>
          <div><dt>Azami süre</dt><dd>{policy.maximumConsentDays} gün</dd></div>
        </dl>
        <a className="clinical-consent__source" href={policy.panelUri} rel="noreferrer" target="_blank">CPIC 2022 kaynak dokümanı ↗</a>
      </article>

      <div className="clinical-consent__grid">
        <article className="card">
          <span className="eyebrow">ERİŞİM SINIRI</span>
          <h2>Yalnız aggregate</h2>
          <p>Yalnız kayıtlı araştırmacı, sabit panel, sabit amaç ve immutable cohort snapshot. Kişi düzeyi çıktı ya da serbest filtre yoktur.</p>
        </article>
        <article className="card">
          <span className="eyebrow">GERİ ÇEKME</span>
          <h2>Gelecek kullanım durur</h2>
          <p>{policy.revocation}</p>
        </article>
      </div>

      <article className="card clinical-consent__excluded">
        <span className="eyebrow">KAPSAM DIŞI</span>
        <ul>{policy.excludes.map((item) => <li key={item}>{item}</li>)}</ul>
      </article>
    </section>
  );
}
