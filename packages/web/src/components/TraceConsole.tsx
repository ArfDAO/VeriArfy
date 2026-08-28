import type { Evidence, TraceStep } from "../lib/trace";
import { shorten, stepDuration } from "../lib/trace";

/**
 * Dogrulama konsolu.
 *
 * Her adimin YANINDA kaniti durur: islem ozeti (Etherscan baglantisiyla),
 * ciphertext handle'i, zincirden geri okunmus deger. "Tamam" yazan ama kanit
 * gostermeyen bir adim, hicbir sey yapmamis olabilir — bu yuzden kanitsiz
 * adim yesil gorunmez.
 *
 * Yesil nokta ile ✓ isareti FARKLI seyler soyler:
 *   nokta = islem hatasiz tamamlandi
 *   ✓     = deger ZINCIRDEN GERI OKUNARAK dogrulandi
 */

const STATUS_LABEL: Record<TraceStep["status"], string> = {
  pending: "bekliyor",
  running: "calisiyor",
  ok: "tamam",
  fail: "hata",
};

function EvidenceRow({ item }: { item: Evidence }) {
  const isLong = item.kind !== "value" && item.kind !== "note";
  const shown = isLong ? shorten(item.value) : item.value;

  return (
    <div className="trace__ev">
      <span className="trace__ev-label">{item.label}</span>
      <span className="trace__ev-value">
        {item.href ? (
          <a
            className="mono trace__link"
            href={item.href}
            target="_blank"
            rel="noreferrer noopener"
            title={item.value}
          >
            {shown}
          </a>
        ) : (
          <span className="mono" title={item.value}>
            {shown}
          </span>
        )}
        {item.verified && (
          <span className="trace__verified" title="Zincirden geri okunarak dogrulandi">
            ✓
          </span>
        )}
      </span>
    </div>
  );
}

export function TraceConsole({
  steps,
  title = "Doğrulama konsolu",
}: {
  steps: TraceStep[];
  title?: string;
}) {
  const verifiedCount = steps.reduce(
    (n, s) => n + s.evidence.filter((e) => e.verified).length,
    0,
  );

  return (
    <section className="trace" aria-label={title}>
      <div className="trace__intro">
        <h3>{title}</h3>
        <span className="eyebrow">
          {steps.length === 0
            ? "HENÜZ ADIM YOK"
            : `${steps.length} ADIM · ${verifiedCount} ZİNCİR KANITI`}
        </span>
      </div>

      {steps.length === 0 ? (
        <p className="card__body">
          Buraya her adım, kanıtıyla birlikte düşer: işlem özeti, blok, harcanan
          gaz, şifreli değerin handle'ı ve zincirden geri okunan sonuç. Boşken
          hiçbir şey iddia edilmez.
        </p>
      ) : (
        <ol className="trace__list">
          {steps.map((step) => {
            const ms = stepDuration(step);
            return (
              <li key={step.id} className={`trace__step trace__step--${step.status}`}>
                <div className="trace__head">
                  <span className={`trace__dot trace__dot--${step.status}`} />
                  <div className="trace__copy">
                    <strong className="trace__label">{step.label}</strong>
                    {step.detail && (
                      <p className={step.status === "fail" ? "trace__detail trace__detail--fail" : "trace__detail"}>
                        {step.detail}
                      </p>
                    )}
                  </div>
                  <span className="eyebrow trace__status">
                    {STATUS_LABEL[step.status]}
                    {ms !== null && ` · ${ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}`}
                  </span>
                </div>

                {step.evidence.length > 0 && (
                  <div className="trace__evidence">
                    {step.evidence.map((item, i) => (
                      <EvidenceRow key={`${item.label}-${i}`} item={item} />
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
