import { useEffect, useState } from "react";

import { E19_CLINICAL_POLICY, validateE19ClinicalPolicy } from "@veriarfy/study";

import { readE19Status, type E19Status } from "../../lib/e19";
import { useT } from "../../lib/i18n";

const policy = validateE19ClinicalPolicy(E19_CLINICAL_POLICY);

/**
 * Dagitim rozeti.
 *
 * Eskiden burada sabit bir "DEPLOY EDILMEDI" metni vardi ve E/19 gercekten
 * dagitildiktan sonra da degismedi; ekran var olan bir sistemi yok gosteriyordu.
 * Rozet artik zincirden okunuyor.
 *
 * Iki ayri gercek karistirilmamali:
 *   - E/19 KONTRATLARI dagitildi mi (asagidaki rozet)
 *   - BU EKRAN zincire onam yaziyor mu (hayir, ve bu kasitli)
 */
function DeploymentBadge({ status }: { status: E19Status | null }) {
  const t = useT();

  if (status === null) {
    return <span className="badge">{t("DURUM OKUNUYOR")}</span>;
  }
  if (status.protocolAddress === null) {
    return <span className="badge badge--warn">{t("DEPLOY EDILMEDI")}</span>;
  }
  if (status.unreachable) {
    // Okunamamak dagitilmamis olmak degildir.
    return <span className="badge">{t("DAGITILDI - ZINCIR OKUNAMADI")}</span>;
  }

  const count = status.participants ?? 0;
  const target = status.participantTarget;
  return (
    <span className="badge badge--ok">
      {target === null
        ? t("DAGITILDI - {count} KATILIMCI", { count })
        : t("DAGITILDI - {count}/{target} KATILIMCI", { count, target })}
    </span>
  );
}

/** Policy receipt, deliberately not a consent action before an E/19 deployment exists. */
export function KlinikOnam() {
  const t = useT();
  const [status, setStatus] = useState<E19Status | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readE19Status().then((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="clinical-consent" aria-labelledby="clinical-consent-title">
      <div className="clinical-consent__heading">
        <div>
          <span className="eyebrow">E/19 / KLİNİK ONAM SINIRI</span>
          <h1 id="clinical-consent-title">Panel, amaç ve geri çekme açık olmalı</h1>
          <p>Bu ekran bir onam makbuzu taslağıdır; zincire onam veya klinik veri yazmaz.</p>
        </div>
        <DeploymentBadge status={status} />
      </div>

      {status?.protocolAddress != null && (
        <div className="notice" role="note">
          {t(
            "E/19 klinik yigini Sepolia'ya dagitildi{block}. Kohort {synthetic}. " +
              "Bu ekran yalnizca onam sinirlarini ilan eder; onami zincire yazan akis " +
              "ayridir ve buradan tetiklenmez.",
            {
              block: status.deployedAtBlock === null ? "" : ` (blok ${status.deployedAtBlock})`,
              synthetic: status.syntheticOnly ? t("sentetiktir") : t("gercek veridir"),
            },
          )}
        </div>
      )}

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
