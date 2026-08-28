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
      setError(userError(err, "Gönderim başarısız. Bağlantıyı kontrol edip yeniden deneyin."));
    } finally {
      setSubmitting(false);
    }
  }, []);

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">Ana içeriğe geç</a>
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
            eyebrow="KATILIM"
            title="Anketi doldurun"
            sub="6 basit soru cevaplayın. Cevaplarınız hem normal hem de FHE ile şifreli olarak işlenecek."
          />
          <div style={{ maxWidth: 780, margin: "0 auto" }}>
            {submitted ? (
              <div className="card card--bone" style={{ textAlign: "center", padding: 48 }}>
                <h3 style={{ marginBottom: 16 }}>Anket kaydı alındı.</h3>
                {lastPrediction && (
                  <div style={{ marginTop: 16 }}>
                    <div className="card__row">
                      <span className="eyebrow">GERÇEK CEVABINIZ</span>
                      <span className="mono">{lastPrediction.true_label === 1 ? "Yüksek Kaygı" : "Sakin"}</span>
                    </div>
                    <div className="card__row">
                      <span className="eyebrow">ŞİFRESİZ MODEL TAHMİNİ</span>
                      <span className="mono" style={{ color: lastPrediction.plain_correct ? "var(--status-success)" : "var(--status-danger)" }}>
                        {lastPrediction.plain_pred === 1 ? "Yüksek Kaygı" : "Sakin"} {lastPrediction.plain_correct ? "doğrulandı" : "uyuşmadı"}
                      </span>
                    </div>
                    <div className="card__row">
                      <span className="eyebrow">ŞİFRELİ (FHE) MODEL TAHMİNİ</span>
                      <span className="mono" style={{ color: lastPrediction.fhe_correct ? "var(--status-success)" : "var(--status-danger)" }}>
                        {lastPrediction.fhe_pred === 1 ? "Yüksek Kaygı" : "Sakin"} {lastPrediction.fhe_correct ? "doğrulandı" : "uyuşmadı"}
                      </span>
                    </div>

                    {lastPrediction.crypto_proof && (
                      <div style={{ marginTop: 24, background: "var(--surface-accent)", borderRadius: 12, padding: 20, textAlign: "left", border: "1px solid var(--border-subtle)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                          <span className="eyebrow" style={{ color: "var(--accent-primary)", margin: 0 }}>FHE ŞİFRELEME KANITI</span>
                        </div>
                        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
                          Verileriniz Zama Concrete ML kullanılarak şifrelendi ve tahmin işlemi bu şifreli devre (ciphertext) üzerinde yapıldı.
                        </p>
                        <div style={{ fontSize: 13, display: "grid", gap: 8 }}>
                          <div>
                            <strong>Şifreli Veri Boyutu:</strong> <span className="mono">{lastPrediction.crypto_proof.ciphertext_size_bytes} Byte</span>
                          </div>
                          <div>
                            <strong>Ciphertext Hex Özeti:</strong> 
                            <div className="mono" style={{ fontSize: 11, background: "var(--surface-muted)", padding: 8, borderRadius: 6, marginTop: 4, wordBreak: "break-all" }}>
                              {lastPrediction.crypto_proof.ciphertext_hex}
                            </div>
                          </div>
                          
                          <div style={{ marginTop: 8 }}>
                            <button 
                              className="pill pill--ghost" 
                              style={{ fontSize: 12, padding: "6px 12px", border: "1px solid var(--accent-primary)", color: "var(--accent-primary)" }}
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
                              Şifreli veriyi indir (.bin)
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <button
                  className="pill pill--primary"
                  style={{ marginTop: 24 }}
                  onClick={() => setSubmitted(false)}
                >
                  Tekrar Doldur
                </button>
              </div>
            ) : (
              <Survey onComplete={handleSubmit} disabled={submitting} />
            )}
          </div>
        </div>
      </div>

      {/* Results Section */}
      <div className="section" style={{ marginTop: 64 }} id="sonuclar">
        <SectionHead
          eyebrow="CANLI SONUÇLAR"
          title="Şifreli vs Şifresiz Model"
          sub="Gerçek kullanıcı verileri üzerinde iki modelin doğruluk karşılaştırması."
        />
        <FheResults results={results} loading={submitting} />
      </div>

      {/* Feature Row */}
      <div className="band">
        <div className="section">
          <SectionHead
            eyebrow="NASIL ÇALIŞIYOR?"
            title="Güven ama doğrula"
            sub="Aynı veri iki bağımsız hattan geçirilir ve sonuçlar kıyaslanır."
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
  const { address, role: selectedRole, restoring } = useSession();

  if (restoring) {
    return (
      <main className="route-loading" aria-live="polite">
        <span className="eyebrow">OTURUM GERI YUKLENIYOR</span>
        <p>Cuzdan baglantisi dogrulaniyor.</p>
      </main>
    );
  }

  if (!address || !selectedRole) return <Navigate to="/giris" replace />;
  if (selectedRole !== role) {
    return <Navigate to={selectedRole === "veri-sahibi" ? "/panel" : "/arastirma"} replace />;
  }

  return <PanelShell role={role} />;
}

export default function App() {
  return (
    <Suspense fallback={<main className="route-loading">Panel yukleniyor...</main>}>
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
