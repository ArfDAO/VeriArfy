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
import { academicDomain, normalizeEmail, profileSource } from "../lib/verificationRules";

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

type PreviewStep = "email" | "method" | "zk";

/** Onizlemede bir adimin islendigini gosteren bekleme suresi. */
const PREVIEW_DELAY_MS = 1400;

const pause = () => new Promise((resolve) => setTimeout(resolve, PREVIEW_DELAY_MS));

/**
 * Dogrulama akisinin ONIZLEMESI.
 *
 * Dogrulama icin gereken hesaplar (e-posta gonderimi, ORCID istemcisi) test
 * aginda henuz kurulmadigi surece gosterilir ve basliginda "Onizleme" yazar.
 * Adres ve profil kurallari gercek akisla ayni (lib/verificationRules), ama
 * e-posta ve akademik durum adimlari DISARI HICBIR SEY GONDERMEZ: kuratore ve
 * zincire dogrulama kaydi yazilmaz. Son adim ise GERCEK ZK kaydidir (acik kayit
 * yolu, `onRegister`).
 *
 * Kontrol listesi bu adimlar bitince maddeyi "Onizleme - tamamlandi" diye
 * gosterir; "Onizleme" ibaresi orada da kalir.
 * Akisin calisan hali `ResearcherVerification`; kurator e-posta dogrulamasi
 * yapilandirildigini bildirdigi anda o gosterilir ve acik kayit kapanir.
 */
export function VerificationPreview({
  onComplete,
  onRegister,
  registering,
  canRegister,
}: {
  /** E-posta ve akademik durum adimlari bitti; ZK adimina gecildi. */
  onComplete: () => void;
  onRegister: () => void;
  registering: boolean;
  canRegister: boolean;
}) {
  const t = useT();
  const [step, setStep] = useState<PreviewStep>("email");
  const [email, setEmail] = useState("");
  const [verifiedEmail, setVerifiedEmail] = useState("");
  const [domain, setDomain] = useState("");
  const [profileUrl, setProfileUrl] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState<"email" | "orcid" | "profile" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const order: PreviewStep[] = ["email", "method", "zk"];
  const reached = order.indexOf(step);
  const chips = [t("Kurum e-postasi"), t("Akademik durum"), t("ZK kaydi")];

  const run = async (kind: "email" | "orcid" | "profile", task: () => void) => {
    setError(null);
    setBusy(kind);
    try {
      await pause();
      task();
    } catch (reason) {
      setError(t(errorText(reason)));
    } finally {
      setBusy(null);
    }
  };

  const verifyEmail = () => {
    setError(null);
    let normalized: string;
    let institution: string;
    try {
      normalized = normalizeEmail(email);
      institution = academicDomain(normalized);
    } catch (reason) {
      setError(t(errorText(reason)));
      return;
    }
    void run("email", () => {
      setVerifiedEmail(normalized);
      setDomain(institution);
      setStep("method");
    });
  };

  const withOrcid = () =>
    void run("orcid", () => {
      setResult(t("ORCID baglandi; guncel kurum {domain} ile eslesti.", { domain }));
      setStep("zk");
      onComplete();
    });

  const withProfile = () => {
    setError(null);
    let source: string;
    try {
      source = profileSource(profileUrl).source;
    } catch (reason) {
      setError(t(errorText(reason)));
      return;
    }
    void run("profile", () => {
      setResult(t("{source} profiliniz onaylandi.", { source }));
      setStep("zk");
      onComplete();
    });
  };

  return (
    <div className="verification verification--preview">
      <ol className="verification__steps" aria-label={t("Dogrulama adimlari")}>
        {chips.map((label, index) => (
          <li key={label} className={index === reached ? "is-current" : index < reached ? "is-done" : ""}>
            {label}
          </li>
        ))}
      </ol>

      {error && <p className="notice notice--warn" role="alert">{error}</p>}

      {step === "email" && (
        <form className="field" onSubmit={(event) => { event.preventDefault(); verifyEmail(); }}>
          <label htmlFor="preview-email">{t("Kurum e-postaniz (.edu.tr)")}</label>
          <input id="preview-email" type="email" required disabled={busy !== null} placeholder="ad.soyad@universite.edu.tr" value={email} onChange={(event) => setEmail(event.target.value)} />
          <button className="pill pill--primary" disabled={!email || busy !== null}>
            {busy === "email" ? <><span className="verification__spinner" aria-hidden="true" />{t("Dogrulaniyor...")}</> : t("Dogrula")}
          </button>
        </form>
      )}

      {step === "method" && (
        <div className="verification__methods">
          <p className="notice notice--ok">{t("{email} dogrulandi.", { email: verifiedEmail })}</p>

          <div className="verification__method">
            <h3>{t("ORCID ile giris")}</h3>
            <p>{t("ORCID kaydinizdaki guncel kurum, e-postanizin kurumuyla resmi ROR kaydi uzerinden eslestirilir. Uygunsa aninda onaylanir.")}</p>
            <button type="button" className="pill pill--primary" disabled={busy !== null} onClick={withOrcid}>
              {busy === "orcid" ? <><span className="verification__spinner" aria-hidden="true" />{t("ORCID'e baglaniliyor...")}</> : t("ORCID ile devam et")}
            </button>
          </div>

          <div className="verification__method">
            <h3>{t("YOK Akademik ya da AVESIS profili")}</h3>
            <form className="field" onSubmit={(event) => { event.preventDefault(); withProfile(); }}>
              <label htmlFor="preview-profile">{t("Profil adresi")}</label>
              <input id="preview-profile" type="url" required disabled={busy !== null} placeholder="https://akademik.yok.gov.tr/..." value={profileUrl} onChange={(event) => setProfileUrl(event.target.value)} />
              <button className="pill" disabled={!profileUrl || busy !== null}>
                {busy === "profile" ? <><span className="verification__spinner" aria-hidden="true" />{t("Inceleniyor...")}</> : t("Gonder")}
              </button>
            </form>
          </div>
        </div>
      )}

      {step === "zk" && (
        <div className="verification__methods">
          {result && <p className="notice notice--ok">{result}</p>}
          <div className="verification__method">
            <h3>{t("Kimliginizi ZK ile kaydedin")}</h3>
            <p>{t("Gizli kimlik tarayicida uretilir. Kurator yalnizca taahhudu gorur; zincir ise kimliginizin akredite agacta oldugunu kanitlar.")}</p>
            <button type="button" className="pill pill--primary" disabled={registering || !canRegister} onClick={onRegister}>
              {registering ? t("Isleniyor...") : t("ZK kimlik kaydini baslat")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
