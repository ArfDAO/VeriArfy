import { NavLink, Outlet, useNavigate } from "react-router-dom";

import { SEPOLIA_CHAIN_ID } from "../config";
import { useT } from "../lib/i18n";
import { LanguageSwitch } from "./LanguageSwitch";
import { useSession, type SessionRole } from "../lib/session";
import { shortAddress } from "../lib/wallet";

const ownerItems = [
  { to: "/panel", label: "Genel bakis", end: true },
  { to: "/panel/veri-yukle", label: "Veri yukle", end: false },
  { to: "/panel/kazanclar", label: "Kazanclar", end: false },
  { to: "/panel/gizlilik", label: "Gizlilik", end: false },
  { to: "/panel/dogrulama", label: "Dogrulama", end: false },
];
const researcherItems = [
  { to: "/arastirma", label: "Kayit ve hazirlik", end: true },
  { to: "/arastirma/veri-al", label: "Veri satin al", end: false },
  { to: "/arastirma/sorgular", label: "Sorgular", end: false },
  { to: "/arastirma/sonuclar", label: "Sonuclar", end: false },
  { to: "/arastirma/dugum", label: "Dugum", end: false },
];

export function PanelShell({ role }: { role: Exclude<SessionRole, null> }) {
  const t = useT();
  const navigate = useNavigate();
  const { address, chainId, researcherRegistered, signOut, switchToSepolia } = useSession();
  const items = role === "veri-sahibi" ? ownerItems : researcherItems;
  const title = t(role === "veri-sahibi" ? "Veri sahibi paneli" : "Arastirmaci paneli");
  const wrongNetwork = chainId !== null && chainId !== SEPOLIA_CHAIN_ID;

  const leave = () => {
    signOut();
    navigate("/giris", { replace: true });
  };

  return (
    <div className="panel-shell">
      <a className="skip-link" href="#main-content">{t("Ana içeriğe geç")}</a>
      <aside className="panel-shell__sidebar" aria-label={t("{title} menusu", { title })}>
        <NavLink className="panel-shell__brand" to="/">
          <span className="panel-shell__mark" aria-hidden="true">va</span>
          <span>veriarfy</span>
        </NavLink>
        <p className="panel-shell__role">{title}</p>
        <nav className="panel-shell__nav">
          {items.map((item) => (
            <NavLink
              className={({ isActive }) => `panel-shell__link${isActive ? " is-active" : ""}`}
              end={item.end}
              key={item.to}
              to={item.to}
            >
              {t(item.label)}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="panel-shell__body">
        <header className="panel-shell__header">
          <div className="panel-shell__network">
            <span className={`panel-shell__status${wrongNetwork ? " is-warning" : ""}`} />
            {wrongNetwork ? t("Yanlis ag") : "Sepolia"}
            {wrongNetwork && (
              <button className="panel-shell__network-action" onClick={() => void switchToSepolia()}>
                {t("Sepolia'ya gec")}
              </button>
            )}
          </div>
          {/* Dil secici panelde de ust seritte: kullanici dili degistirmek
              icin ana sayfaya donmek zorunda kalmamali. */}
          <LanguageSwitch />
          <div className="panel-shell__account">
            <span className="mono">{address ? shortAddress(address) : t("Bagli degil")}</span>
            <button className="panel-shell__signout" onClick={leave}>{t("Giris ekranina don")}</button>
          </div>
        </header>

        <main className="panel-shell__content" id="main-content">
          {role === "arastirmaci" && researcherRegistered === false && (
            <div className="notice notice--warn panel-shell__registration-notice" role="status">
              {t("Bu cuzdan arastirmaci defterinde kayitli degil. Sorgu acmadan once ZK kimlik kaydini tamamlamaniz gerekiyor.")}
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
