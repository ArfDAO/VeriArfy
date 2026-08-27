import { NavLink, Outlet, useNavigate } from "react-router-dom";

import { SEPOLIA_CHAIN_ID } from "../config";
import { useSession, type SessionRole } from "../lib/session";
import { shortAddress } from "../lib/wallet";

const ownerItems = [{ to: "/panel", label: "Genel bakis", end: true }];
const researcherItems = [{ to: "/arastirma", label: "Genel bakis", end: true }];

export function PanelShell({ role }: { role: Exclude<SessionRole, null> }) {
  const navigate = useNavigate();
  const { address, chainId, researcherRegistered, signOut, switchToSepolia } = useSession();
  const items = role === "veri-sahibi" ? ownerItems : researcherItems;
  const title = role === "veri-sahibi" ? "Veri sahibi paneli" : "Arastirmaci paneli";
  const wrongNetwork = chainId !== null && chainId !== SEPOLIA_CHAIN_ID;

  const leave = () => {
    signOut();
    navigate("/giris", { replace: true });
  };

  return (
    <div className="panel-shell">
      <aside className="panel-shell__sidebar" aria-label={`${title} menusu`}>
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
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="panel-shell__body">
        <header className="panel-shell__header">
          <div className="panel-shell__network">
            <span className={`panel-shell__status${wrongNetwork ? " is-warning" : ""}`} />
            {wrongNetwork ? "Yanlis ag" : "Sepolia"}
            {wrongNetwork && (
              <button className="panel-shell__network-action" onClick={() => void switchToSepolia()}>
                Sepolia'ya gec
              </button>
            )}
          </div>
          <div className="panel-shell__account">
            <span className="mono">{address ? shortAddress(address) : "Bagli degil"}</span>
            <button className="panel-shell__signout" onClick={leave}>Cikis</button>
          </div>
        </header>

        <main className="panel-shell__content" id="main-content">
          {role === "arastirmaci" && researcherRegistered === false && (
            <div className="notice notice--warn panel-shell__registration-notice" role="status">
              Bu cuzdan arastirmaci defterinde kayitli degil. Sorgu acmadan once ZK kimlik kaydini tamamlamaniz gerekiyor.
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
