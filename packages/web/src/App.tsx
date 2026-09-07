import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Nav } from "./components/Nav";
import { Hero } from "./components/Hero";
import {
  FeatureRow,
  Footer,
  LimitsRow,
  PricingRow,
  ProblemRow,
  SectionHead,
  TechRow,
} from "./components/Marketing";
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

/**
 * Halka acik tanitim sayfasi.
 *
 * ANKET KALDIRILDI. Eski sayfa duz metin anket yanitlarini bir Python
 * servisine gonderiyordu; ayni ekranda "verileriniz sifreli" baslıgi ile
 * duz metin gonderen bir form yan yana duruyordu. Kaldirilmasi hem o
 * celiskiyi hem de dagitimda ayri bir servis bagimliligini bitirdi —
 * sayfa artik tamamen statik ve hicbir arka uca ihtiyac duymuyor.
 */
function AnaSayfa() {
  const t = useT();

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">{t("Ana içeriğe geç")}</a>
      <Nav />

      <main id="main-content">
        <Hero />

        {/* --- Sorun --- */}
        <div className="band" id="sorun">
          <div className="section">
            <SectionHead
              eyebrow={t("SORUN")}
              title={t("Veri değerli, sahibi karşılıksız")}
              sub={t("Genomik veri araştırmacılar için çok değerli; verinin geldiği kişi için neredeyse hiçbir şey ifade etmiyor.")}
            />
            <ProblemRow />
          </div>
        </div>

        {/* --- Nasıl çalışır --- */}
        <div className="section" id="yontem">
          <SectionHead
            eyebrow={t("NASIL ÇALIŞIYOR")}
            title={t("Şifreli kalır, yine de hesaplanır")}
            sub={t("Veri cihazınızda şifrelenir ve öyle kalır. Zincir üstünde yapılan her işlem şifreli değerler üzerinde çalışır.")}
          />
          <FeatureRow />
        </div>

        {/* --- Ödeme modeli --- */}
        <div className="band">
          <div className="section">
            <SectionHead
              eyebrow={t("ÖDEME")}
              title={t("Kullanıldığı kadar, nadirliği kadar")}
              sub={t("Araştırmacı yalnızca ihtiyaç duyduğu alanları satın alır. Az bulunan veri, sahibine kişi başına daha fazla kazandırır.")}
            />
            <PricingRow />
          </div>
        </div>

        {/* --- Teknoloji --- */}
        <div className="section" id="teknoloji">
          <SectionHead
            eyebrow={t("TEKNOLOJİ")}
            title={t("Üç katman")}
            sub={t("Her katman farklı bir soruyu çözüyor; hiçbiri tek başına yeterli değil.")}
          />
          <TechRow />
        </div>

        {/* --- Sınırlar --- */}
        <div className="band">
          <div className="section">
            <SectionHead
              eyebrow={t("DÜRÜST SINIRLAR")}
              title={t("Sistem neyi kanıtlamıyor")}
              sub={t("Bir sistemin ne yapmadığını bilmek, ne yaptığını bilmek kadar önemlidir.")}
            />
            <LimitsRow />
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
