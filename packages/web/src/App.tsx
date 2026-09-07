import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { userError } from "./lib/userError";
import { Nav } from "./components/Nav";
import { Hero } from "./components/Hero";
import { Survey, SurveyResult } from "./components/Survey";
import { FheResults } from "./components/FheResults";
import { SectionHead, FeatureRow, Footer, StatRow } from "./components/Marketing";
import { submitSurvey, getResults, getStats, type AnalysisResults } from "./lib/api";
import { PanelShell } from "./components/PanelShell";
import { useSession, type SessionRole } from "./lib/session";
import { useT } from "./lib/i18n";

const Giris = lazy(async () => ({ default: (await import("./routes/Giris")).Giris }));
const Ozet = lazy(async () => ({ default: (await import("./routes/panel/Ozet")).Ozet }));
const VeriYukle = lazy(async () => ({ default: (await import("./routes/panel/VeriYukle")).VeriYukle }));
const Kazanclar = lazy(async () => ({ default: (await import("./routes/panel/Kazanclar")).Kazanclar }));
const Gizlilik = lazy(async () => ({ default: (await import("./routes/panel/Gizlilik")).Gizlilik }));
const Dogrulama = lazy(async () => ({ default: (await import("./routes/panel/Dogrulama")).Dogrulama }));
const Kayit = lazy(async () => ({ default: (await import("./routes/arastirma/Kayit")).Kayit }));
const VeriAl = lazy(async () => ({ default: (await import("./routes/arastirma/VeriAl")).VeriAl }));
const Sorgular = lazy(async () => ({ default: (await import("./routes/arastirma/Sorgular")).Sorgular }));
const Sonuclar = lazy(async () => ({ default: (await import("./routes/arastirma/Sonuclar")).Sonuclar }));
const Dugum = lazy(async () => ({ default: (await import("./routes/arastirma/Dugum")).Dugum }));

function AnaSayfa() {
  const t = useT();
  const [participantCount, setParticipantCount] = useState<number | null>(null);
  const [results, setResults] = useState<AnalysisResults | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [lastPrediction, setLastPrediction] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch stats on load
  useEffect(() => {
    getStats()
      .then((s) => setParticipantCount(s.total_participants))
      .catch(() => {});
    getResults()
      .then(setResults)
      .catch(() => {});
  }, []);

  const handleSubmit = useCallback(async (data: SurveyResult) => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await submitSurvey(data);
      // Backend returns { prediction: {...}, results: {...} }
      const pred = (response as any).prediction ?? response;
      setLastPrediction(pred);
      setSubmitted(true);
      setParticipantCount((c) => (c ?? 0) + 1);
      // Refresh results
      const newResults = await getResults();
      setResults(newResults);
    } catch (err: any) {
      setError(userError(err, t("Gönderim başarısız. Bağlantıyı kontrol edip yeniden deneyin.")));
    } finally {
      setSubmitting(false);
    }
  }, []);

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">{t("Ana içeriğe geç")}</a>
      <Nav />

      {error && (
        <div className="section" style={{ marginTop: 12 }}>
          <div className="notice notice--warn">{error}</div>
        </div>
      )}

      <main id="main-content">
        <Hero />
        <StatRow participants={participantCount} />

      {/* Survey Section */}
      <div className="band" id="anket">
        <div className="section">
          <SectionHead
            eyebrow={t("KATILIM")}
            title={t("Anketi doldurun")}
            sub={t("6 basit soru cevaplayın. Cevaplarınız hem normal hem de FHE ile şifreli olarak işlenecek.")}
          />
          <div className="survey-shell">
            {submitted ? (
              <section className="survey-completion" aria-live="polite">
                <span className="eyebrow">{t("KAYIT TAMAMLANDI")}</span>
                <h3>{t("Anket kaydı alındı.")}</h3>
                {lastPrediction && (
                  <div className="survey-completion__outcomes">
                    <div className="card__row">
                      <span className="eyebrow">{t("GERÇEK CEVABINIZ")}</span>
                      <span className="mono">{t(lastPrediction.true_label === 1 ? "Yüksek Kaygı" : "Sakin")}</span>
                    </div>
                    <div className="card__row">
                      <span className="eyebrow">{t("ŞİFRESİZ MODEL TAHMİNİ")}</span>
                      <span className={`mono survey-completion__prediction ${lastPrediction.plain_correct ? "is-verified" : "is-mismatch"}`}>
                        {t(lastPrediction.plain_pred === 1 ? "Yüksek Kaygı" : "Sakin")} {t(lastPrediction.plain_correct ? "doğrulandı" : "uyuşmadı")}
                      </span>
                    </div>
                    <div className="card__row">
                      <span className="eyebrow">{t("ŞİFRELİ (FHE) MODEL TAHMİNİ")}</span>
                      <span className={`mono survey-completion__prediction ${lastPrediction.fhe_correct ? "is-verified" : "is-mismatch"}`}>
                        {t(lastPrediction.fhe_pred === 1 ? "Yüksek Kaygı" : "Sakin")} {t(lastPrediction.fhe_correct ? "doğrulandı" : "uyuşmadı")}
                      </span>
                    </div>

                    {lastPrediction.crypto_proof && (
                      <article className="survey-proof">
                        <span className="eyebrow">{t("FHE ŞİFRELEME KANITI")}</span>
                        <p>
                          {t("Verileriniz Zama Concrete ML kullanılarak şifrelendi ve tahmin işlemi bu şifreli devre (ciphertext) üzerinde yapıldı.")}
                        </p>
                        <div className="survey-proof__facts">
                          <div className="card__row">
                            <span>{t("Şifreli veri boyutu")}</span><strong className="mono">{lastPrediction.crypto_proof.ciphertext_size_bytes} Byte</strong>
                          </div>
                          <div className="survey-proof__hash">
                            <span>{t("Ciphertext hex özeti")}</span>
                            <div className="mono">
                              {lastPrediction.crypto_proof.ciphertext_hex}
                            </div>
                          </div>
                          <div>
                            <button
                              className="pill pill--ghost"
                              onClick={() => {
                                const hex = lastPrediction.crypto_proof.ciphertext_full_hex;
                                if (!hex) return;
                                
                                const bytes = new Uint8Array(hex.length / 2);
                                for (let i = 0; i < hex.length; i += 2) {
                                  bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
                                }
                                
                                const blob = new Blob([bytes], { type: "application/octet-stream" });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = "zama_fhe_ciphertext.bin";
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                                URL.revokeObjectURL(url);
                              }}
                            >
                              {t("Şifreli veriyi indir (.bin)")}
                            </button>
                          </div>
                        </div>
                      </article>
                    )}
                  </div>
                )}
                <button
                  className="pill pill--primary"
                  onClick={() => setSubmitted(false)}
                >
                  {t("Tekrar Doldur")}
                </button>
              </section>
            ) : (
              <Survey onComplete={handleSubmit} disabled={submitting} />
            )}
          </div>
        </div>
      </div>

      {/* Results Section */}
      <div className="section results-section" id="sonuclar">
        <SectionHead
          eyebrow={t("CANLI SONUÇLAR")}
          title={t("Şifreli vs Şifresiz Model")}
          sub={t("Gerçek kullanıcı verileri üzerinde iki modelin doğruluk karşılaştırması.")}
        />
        <FheResults results={results} loading={submitting} />
      </div>

      {/* Feature Row */}
      <div className="band">
        <div className="section">
          <SectionHead
            eyebrow={t("NASIL ÇALIŞIYOR?")}
            title={t("Güven ama doğrula")}
            sub={t("Aynı veri iki bağımsız hattan geçirilir ve sonuçlar kıyaslanır.")}
          />
          <FeatureRow />
        </div>
      </div>

        <Footer />
      </main>
    </div>
  );
}

function RoleGate({ role }: { role: Exclude<SessionRole, null> }) {
  const t = useT();
  const { address, role: selectedRole, restoring } = useSession();

  if (restoring) {
    return (
      <main className="route-loading" aria-live="polite">
        <span className="eyebrow">{t("OTURUM GERI YUKLENIYOR")}</span>
        <p>{t("Cuzdan baglantisi dogrulaniyor.")}</p>
      </main>
    );
  }

  if (!address || !selectedRole) return <Navigate to="/giris" replace />;
  if (selectedRole !== role) {
    return <Navigate to={selectedRole === "veri-sahibi" ? "/panel" : "/arastirma"} replace />;
  }

  return <PanelShell role={role} />;
}

function PanelFallback() {
  const t = useT();
  return <main className="route-loading">{t("Panel yukleniyor...")}</main>;
}

export default function App() {
  return (
    <Suspense fallback={<PanelFallback />}>
      <Routes>
        <Route path="/" element={<AnaSayfa />} />
        <Route path="/giris" element={<Giris />} />
        <Route path="/panel/*" element={<RoleGate role="veri-sahibi" />}>
          <Route index element={<Ozet />} />
          <Route path="veri-yukle" element={<VeriYukle />} />
          <Route path="kazanclar" element={<Kazanclar />} />
          <Route path="gizlilik" element={<Gizlilik />} />
          <Route path="dogrulama" element={<Dogrulama />} />
        </Route>
        <Route path="/arastirma/*" element={<RoleGate role="arastirmaci" />}>
          <Route index element={<Kayit />} />
          <Route path="veri-al" element={<VeriAl />} />
          <Route path="sorgular" element={<Sorgular />} />
          <Route path="sonuclar" element={<Sonuclar />} />
          <Route path="dugum" element={<Dugum />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
