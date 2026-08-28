import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { SEPOLIA_CHAIN_ID } from "../config";
import { useSession, type SessionRole } from "../lib/session";
import { shortAddress } from "../lib/wallet";

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
  const [pickerOpen, setPickerOpen] = useState(false);
  const {
    address,
    activeWallet,
    chainId,
    connect,
    error,
    restoring,
    switchToSepolia,
    selectRole,
    walletAvailable,
    wallets,
    disconnect,
  } = useSession();
  const wrongNetwork = chainId !== null && chainId !== SEPOLIA_CHAIN_ID;

  const chooseRole = (role: Exclude<SessionRole, null>, destination: string) => {
    selectRole(role);
    navigate(destination);
  };

  return (
    <main className="login-page" id="main-content">
      <section className="login-page__intro">
        <Link className="login-page__brand" to="/">veriarfy</Link>
        <span className="eyebrow">ERISIM SECIMI</span>
        <h1>Hangi taraftan devam edeceksiniz?</h1>
        <p>Cuzdan yalnizca oturum kimligidir. Arastirmaci yetkisi her zaman zincirdeki defterden yeniden dogrulanir.</p>
      </section>

      <section className="login-page__flow" aria-live="polite">
        {address && (
          <div className="login-page__session">
            <span>
              {activeWallet?.name ?? "Cuzdan"} · <span className="mono">{shortAddress(address)}</span>
            </span>
            <div className="login-page__session-actions">
              <button onClick={() => { disconnect(); setPickerOpen(true); }} type="button">Cuzdani degistir</button>
              <button onClick={disconnect} type="button">Cuzdandan cik</button>
            </div>
          </div>
        )}
        {!walletAvailable ? (
          <div className="notice notice--warn">Ethereum cuzdani bulunamadi. MetaMask gibi bir cuzdani etkinlestirip sayfayi yenileyin.</div>
        ) : !address ? (
          <div className="login-page__connect">
            <p>{restoring ? "Mevcut cuzdan oturumu kontrol ediliyor..." : "Devam etmek icin bir cuzdan secin."}</p>
            <button className="pill pill--primary" disabled={restoring} onClick={() => setPickerOpen(true)}>
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

      {pickerOpen && (
        <div className="wallet-dialog-backdrop" onMouseDown={() => setPickerOpen(false)}>
          <section
            aria-labelledby="wallet-dialog-title"
            aria-modal="true"
            className="wallet-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="wallet-dialog__head">
              <div>
                <span className="eyebrow">CUZDAN BAGLANTISI</span>
                <h2 id="wallet-dialog-title">Cuzdaninizi secin</h2>
              </div>
              <button aria-label="Cuzdan secicisini kapat" onClick={() => setPickerOpen(false)} type="button">Kapat</button>
            </div>
            <div className="wallet-picker" aria-label="Cuzdan secimi">
              {wallets.map((wallet) => (
                <button
                  className="wallet-picker__option"
                  disabled={restoring}
                  key={wallet.id}
                  onClick={() => {
                    setPickerOpen(false);
                    void connect(wallet.id);
                  }}
                  type="button"
                >
                  <span>{wallet.name}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
