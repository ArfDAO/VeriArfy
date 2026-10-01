import { useCallback, useEffect, useState } from "react";

import {
  confirmEmailVerification,
  isAccredited,
  startEmailVerification,
  startOrcidVerification,
  submitProfileForReview,
  verificationStatus,
  type VerificationStatus,
} from "../lib/curator";
import { useT } from "../lib/i18n";

type Step = "email" | "code" | "method" | "pending";

const reviewKey = (address: string) => `veriarfy.researcher.review.${address.toLowerCase()}`;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Arastirmaci dogrulamasi.
 *
 * Akredite listeye kimse dogrudan giremez. Kisi once kurum e-postasina (.edu.tr)
 * gelen kodla kutuya eristigini, sonra ORCID ile giris yaparak ya da YOK Akademik
 * / AVESIS profiliyle akademik durumunu gosterir. Onay sonrasi kisi listeye TEK
 * bir kimlikle eklenir; zincirde hangi akredite kisinin islem yaptigini ZK kaydi
 * gizler.
 */
export function ResearcherVerification({
  address,
  ensureCommitment,
  onAccredited,
}: {
  address: string;
  /** Kimlik yoksa uretir ve saklar; taahhudu dondurur. */
  ensureCommitment: () => bigint;
  onAccredited: () => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<VerificationStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(() => {
    try {
      return window.localStorage.getItem(reviewKey(address)) ? "pending" : "email";
    } catch {
      return "email";
    }
  });
  const [email, setEmail] = useState("");
  const [challenge, setChallenge] = useState("");
  const [code, setCode] = useState("");
  const [session, setSession] = useState<{ token: string; email: string } | null>(null);
  const [profileUrl, setProfileUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    verificationStatus()
      .then((next) => !cancelled && setStatus(next))
      .catch((reason) => !cancelled && setStatusError(errorText(reason)));
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }, []);

  const sendCode = () =>
    run(async () => {
      const result = await startEmailVerification(email);
      setChallenge(result.challenge);
      setCode("");
      setStep("code");
    });

  const confirmCode = () =>
    run(async () => {
      const result = await confirmEmailVerification(challenge, code);
      setSession({ token: result.emailSession, email: result.email });
      setStep("method");
    });

  const withOrcid = () =>
    run(async () => {
      if (!session) return;
      const url = await startOrcidVerification(session.token, ensureCommitment());
      // ORCID girisi kendi sayfasinda yapilir; sonuc bu ekrana geri doner.
      window.location.assign(url);
    });

  const withProfile = () =>
    run(async () => {
      if (!session) return;
      await submitProfileForReview(session.token, ensureCommitment(), profileUrl);
      try {
        window.localStorage.setItem(reviewKey(address), String(Date.now()));
      } catch {
        /* depolama yoksa bekleme durumu yalnizca bu oturumda gorunur */
      }
      setStep("pending");
    });

  const checkReview = () =>
    run(async () => {
      if (await isAccredited(ensureCommitment())) {
        try {
          window.localStorage.removeItem(reviewKey(address));
        } catch {
          /* yok say */
        }
        onAccredited();
      } else {
        setError(t("Basvurunuz henuz onaylanmadi. Onaylandiginda kurum e-postaniza bildirim gelecek."));
      }
    });

  if (statusError) {
    return <p className="notice notice--warn">{t("Dogrulama servisine ulasilamadi: {error}", { error: statusError })}</p>;
  }
  if (!status) {
    return <p className="researcher-setup__action-note">{t("Dogrulama servisi hazirlaniyor...")}</p>;
  }
  if (!status.email) {
    return (
      <div className="notice notice--warn">
        {t("Arastirmaci dogrulamasi henuz yapilandirilmadi: kurum e-postasina kod gonderimi kurulum bekliyor. Dogrulamasiz kayit bilincli olarak kapali.")}
      </div>
    );
  }

  return (
    <div className="verification">
      <ol className="verification__steps" aria-label={t("Dogrulama adimlari")}>
        <li className={step === "email" || step === "code" ? "is-current" : "is-done"}>{t("Kurum e-postasi")}</li>
        <li className={step === "method" ? "is-current" : step === "pending" ? "is-done" : ""}>{t("Akademik durum")}</li>
        <li>{t("ZK kaydi")}</li>
      </ol>

      {error && <p className="notice notice--warn" role="alert">{error}</p>}

      {step === "email" && (
        <form className="field" onSubmit={(event) => { event.preventDefault(); void sendCode(); }}>
          <label htmlFor="verify-email">{t("Kurum e-postaniz (.edu.tr)")}</label>
          <input id="verify-email" type="email" autoComplete="email" required placeholder="ad.soyad@universite.edu.tr" value={email} onChange={(event) => setEmail(event.target.value)} />
          <button className="pill pill--primary" disabled={busy || !email}>{busy ? t("Gonderiliyor...") : t("Kod gonder")}</button>
          <p className="researcher-setup__action-note">{t("Universite bu adresi yalnizca kendi mensuplarina verir; koda erismeniz adresin size ait oldugunu gosterir.")}</p>
        </form>
      )}

      {step === "code" && (
        <form className="field" onSubmit={(event) => { event.preventDefault(); void confirmCode(); }}>
          <label htmlFor="verify-code">{t("{email} adresine gelen 6 haneli kod", { email })}</label>
          <input id="verify-code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} />
          <button className="pill pill--primary" disabled={busy || code.length !== 6}>{busy ? t("Dogrulaniyor...") : t("Dogrula")}</button>
          <button type="button" className="pill pill--ghost" disabled={busy} onClick={() => setStep("email")}>{t("Adresi degistir")}</button>
        </form>
      )}

      {step === "method" && session && (
        <div className="verification__methods">
          <p className="notice notice--ok">{t("{email} dogrulandi.", { email: session.email })}</p>
          <p className="researcher-setup__action-note">{t("Kurum e-postasi mensubiyeti gosterir; akademik durumunuzu da gostermeniz gerekiyor. Bir yol secin:")}</p>

          <div className="verification__method">
            <h3>{t("ORCID ile giris")}</h3>
            <p>{t("ORCID kaydinizdaki guncel kurum, e-postanizin kurumuyla resmi ROR kaydi uzerinden eslestirilir. Uygunsa aninda onaylanir.")}</p>
            {status.orcid
              ? <button className="pill pill--primary" disabled={busy} onClick={() => void withOrcid()}>{t("ORCID ile devam et")}</button>
              : <p className="notice notice--warn">{t("ORCID ile giris henuz yapilandirilmadi.")}</p>}
          </div>

          <div className="verification__method">
            <h3>{t("YOK Akademik ya da AVESIS profili")}</h3>
            <p>{t("Bu profillerin sahipligi otomatik dogrulanamiyor; basvurunuz bir operator tarafindan incelenir.")}</p>
            {status.profile ? (
              <form className="field" onSubmit={(event) => { event.preventDefault(); void withProfile(); }}>
                <label htmlFor="verify-profile">{t("Profil adresi")}</label>
                <input id="verify-profile" type="url" required placeholder="https://akademik.yok.gov.tr/..." value={profileUrl} onChange={(event) => setProfileUrl(event.target.value)} />
                <button className="pill" disabled={busy || !profileUrl}>{busy ? t("Gonderiliyor...") : t("Incelemeye gonder")}</button>
              </form>
            ) : <p className="notice notice--warn">{t("Profil incelemesi henuz yapilandirilmadi.")}</p>}
          </div>
        </div>
      )}

      {step === "pending" && (
        <div className="verification__pending">
          <p className="notice notice--info">{t("Basvurunuz incelemede. Onaylandiginda kurum e-postaniza bildirim gelir; sonra bu ekrandan ZK kaydiniza devam edebilirsiniz.")}</p>
          <button className="pill pill--primary" disabled={busy} onClick={() => void checkReview()}>{busy ? t("Kontrol ediliyor...") : t("Durumu kontrol et")}</button>
        </div>
      )}
    </div>
  );
}

/**
 * Dogrulama akisinin ONIZLEMESI.
 *
 * Dogrulama icin gereken hesaplar (e-posta gonderimi, ORCID istemcisi) test
 * aginda henuz kurulmadigi surece gosterilir. Akisin adimlari tiklanarak
 * gezilebilir, ama tum kontroller DEVRE DISIDIR ve ekran hicbir yerde bir
 * dogrulamanin gerceklestigini soylemez: katilimcilar verilerine kimin
 * erisebildigini bu ekrana bakarak anlar, gerceklesmemis bir dogrulamayi
 * gerceklesmis gibi gostermek onlari yaniltirdi.
 *
 * Akisin calisan hali `ResearcherVerification`; kurator e-posta dogrulamasi
 * yapilandirildigini bildirdigi anda o gosterilir ve acik kayit kapanir.
 */
export function VerificationPreview() {
  const t = useT();
  const [active, setActive] = useState(0);
  const steps = [t("Kurum e-postasi"), t("Akademik durum"), t("ZK kaydi")];

  return (
    <article className="card verification verification--preview" aria-labelledby="verification-preview-title">
      <div className="card__head">
        <h2 id="verification-preview-title">{t("Arastirmaci dogrulamasi")}</h2>
        <span className="badge badge--warn">{t("ONIZLEME")}</span>
      </div>
      <p className="notice notice--info">
        {t("Test aginda dogrulama henuz etkin degil; kayit simdilik dogrulamasiz acik. Asagida, dogrulama etkinlestiginde izlenecek akis gorunuyor.")}
      </p>

      <ol className="verification__steps" aria-label={t("Dogrulama adimlari")}>
        {steps.map((label, index) => (
          <li key={label} className={index === active ? "is-current" : ""}>
            <button type="button" className="verification__step-button" aria-current={index === active ? "step" : undefined} onClick={() => setActive(index)}>
              {index + 1}. {label}
            </button>
          </li>
        ))}
      </ol>

      {active === 0 && (
        <div className="field">
          <label htmlFor="preview-email">{t("Kurum e-postaniz (.edu.tr)")}</label>
          <input id="preview-email" type="email" disabled placeholder="ad.soyad@universite.edu.tr" />
          <button type="button" className="pill" disabled>{t("Kod gonder")}</button>
          <p className="researcher-setup__action-note">
            {t("Kurum e-postasina 6 haneli kod gider; kodu girmek adresin size ait oldugunu gosterir. Gmail gibi kisisel adresler ve ogrenci alt alan adlari kabul edilmez. Ayni adres ikinci bir kimlik acamaz.")}
          </p>
        </div>
      )}

      {active === 1 && (
        <div className="verification__methods">
          <div className="verification__method">
            <h3>{t("ORCID ile giris")}</h3>
            <p>{t("ORCID kaydinizdaki guncel kurum, e-postanizin kurumuyla resmi ROR kaydi uzerinden eslestirilir. Uygunsa aninda onaylanir.")}</p>
            <button type="button" className="pill" disabled>{t("ORCID ile devam et")}</button>
          </div>
          <div className="verification__method">
            <h3>{t("YOK Akademik ya da AVESIS profili")}</h3>
            <p>{t("Bu profillerin sahipligi otomatik dogrulanamiyor; basvurunuz bir operator tarafindan incelenir.")}</p>
            <div className="field">
              <label htmlFor="preview-profile">{t("Profil adresi")}</label>
              <input id="preview-profile" type="url" disabled placeholder="https://akademik.yok.gov.tr/..." />
            </div>
          </div>
        </div>
      )}

      {active === 2 && (
        <div className="verification__method">
          <p>{t("Onaylanan kimlik akredite listeye tek bir kimlikle eklenir ve liste zincirde tutulur. Kayit sirasinda kimliginiz tarayicinizda kalir; zincirde hangi akredite kisinin islem yaptigini sifir-bilgi kaniti gizler.")}</p>
        </div>
      )}
    </article>
  );
}
