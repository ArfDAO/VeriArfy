import { Link, useNavigate } from "react-router-dom";

import { SEPOLIA_CHAIN_ID } from "../config";
import { useSession, type SessionRole } from "../lib/session";

const roles: Array<{
  role: Exclude<SessionRole, null>;
  title: string;
  description: string;
  destination: string;
}> = [
  {
    role: "veri-sahibi",
    title: "Veri sahibi",
    description: "Genomik ve biyobelirtec verinizi sifreleyerek havuza katilir, sorgu odullerini takip edersiniz.",
    destination: "/panel",
  },
  {
    role: "arastirmaci",
    title: "Arastirmaci",
    description: "Alan secerek grup toplamlarini satin alir, onay surecini izler ve istatistiksel sonucu gorursunuz.",
    destination: "/arastirma",
  },
];

export function Giris() {
  const navigate = useNavigate();
  const { address, chainId, connect, error, restoring, switchToSepolia, selectRole, walletAvailable } = useSession();
  const wrongNetwork = chainId !== null && chainId !== SEPOLIA_CHAIN_ID;

  const chooseRole = (role: Exclude<SessionRole, null>, destination: string) => {
    selectRole(role);
    navigate(destination);
  };

  return (
    <main className="login-page">
      <section className="login-page__intro">
        <Link className="login-page__brand" to="/">veriarfy</Link>
        <span className="eyebrow">ERISIM SECIMI</span>
        <h1>Hangi taraftan devam edeceksiniz?</h1>
        <p>Cuzdan yalnizca oturum kimligidir. Arastirmaci yetkisi her zaman zincirdeki defterden yeniden dogrulanir.</p>
      </section>

      <section className="login-page__flow" aria-live="polite">
        {!walletAvailable ? (
          <div className="notice notice--warn">Ethereum cuzdani bulunamadi. MetaMask gibi bir cuzdani etkinlestirip sayfayi yenileyin.</div>
        ) : !address ? (
          <div className="login-page__connect">
            <p>{restoring ? "Mevcut cuzdan oturumu kontrol ediliyor..." : "Devam etmek icin cuzdaninizi baglayin."}</p>
            <button className="pill pill--primary" disabled={restoring} onClick={() => void connect()}>
              Cuzdani bagla
            </button>
          </div>
        ) : wrongNetwork ? (
          <div className="login-page__connect">
            <p>Bu uygulama Sepolia aginda calisir. Rol secmeden once agi degistirin.</p>
            <button className="pill pill--primary" onClick={() => void switchToSepolia()}>Sepolia'ya gec</button>
          </div>
        ) : (
          <div className="login-page__roles">
            {roles.map((item) => (
              <article className="login-page__role" key={item.role}>
                <span className="eyebrow">{item.title}</span>
                <h2>{item.title} olarak devam edin</h2>
                <p>{item.description}</p>
                <button className="pill pill--primary" onClick={() => chooseRole(item.role, item.destination)}>
                  Paneli ac
                </button>
              </article>
            ))}
          </div>
        )}
        {error && <div className="notice notice--warn">{error}</div>}
      </section>
    </main>
  );
}
