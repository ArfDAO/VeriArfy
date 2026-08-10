import { useCallback, useEffect, useState } from "react";
import type { BrowserProvider } from "ethers";

import { Nav } from "./components/Nav";
import { Hero } from "./components/Hero";
import { Participate } from "./components/Participate";
import { Survey } from "./components/Survey";
import { Results } from "./components/Results";
import { SectionHead, FeatureRow, Footer, StatRow } from "./components/Marketing";
import { connectWallet, ensureSepolia, isSepolia, hasWallet } from "./lib/wallet";
import { readParticipantState } from "./lib/contracts";
import { isDeployed } from "./config";

/** Tasarim onizlemesi: ?preview=survey ile anketi zincir olmadan gorun. */
function usePreviewMode() {
  return new URLSearchParams(window.location.search).get("preview");
}

export default function App() {
  const preview = usePreviewMode();
  const [provider, setProvider] = useState<BrowserProvider | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [participantCount, setParticipantCount] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    setError(null);
    try {
      const res = await connectWallet();
      setProvider(res.provider);
      setAddress(res.address);
      setChainId(res.chainId);
      if (!isSepolia(res.chainId)) await ensureSepolia();
    } catch (err: any) {
      setError(err?.message ?? "Cuzdan baglanamadi.");
    }
  }, []);

  useEffect(() => {
    if (!provider || !address || !isDeployed) return;
    readParticipantState(provider, address)
      .then((s) => setParticipantCount(s.participantCount))
      .catch(() => setParticipantCount(null));
  }, [provider, address, refreshKey]);

  useEffect(() => {
    if (!hasWallet()) return;
    const eth = window.ethereum!;
    const onAccounts = (a: string[]) => setAddress(a[0] ?? null);
    const onChain = (hex: string) => setChainId(parseInt(hex, 16));
    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const wrongNetwork = chainId != null && !isSepolia(chainId);

  if (preview === "survey") {
    return (
      <div className="app">
        <Nav address={address} onConnect={connect} />
        <div className="section" style={{ paddingTop: 32, paddingBottom: 64 }}>
          <div className="notice notice--warn" style={{ marginBottom: 24 }}>
            Tasarim onizlemesi — zincire bir sey gonderilmez.
          </div>
          <div style={{ maxWidth: 780, margin: "0 auto" }}>
            <Survey onComplete={(r) => console.log("onizleme sonucu", r)} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Nav address={address} onConnect={connect} />

      {wrongNetwork && (
        <div className="section" style={{ marginTop: 12 }}>
          <div className="notice notice--warn" style={{ marginTop: 0 }}>
            Yanlis ag — bu calisma Sepolia uzerinde yurutuluyor.{" "}
            <button
              className="pill pill--ghost"
              style={{ padding: "6px 12px" }}
              onClick={ensureSepolia}
            >
              Sepolia'ya gec
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="section" style={{ marginTop: 12 }}>
          <div className="notice notice--warn" style={{ marginTop: 0 }}>{error}</div>
        </div>
      )}

      <Hero />

      <StatRow participants={participantCount} />

      <div className="band">
        <div className="section">
          <SectionHead
            eyebrow="KATILIM"
            title="Calismaya katilin"
            sub="Kimliginiz acilmadan dogrulanir, yanitlariniz cihazinizda sifrelenir."
          />
          <div id="katil" style={{ maxWidth: 780, margin: "0 auto" }}>
            <Participate
              provider={provider}
              address={address}
              onConnect={connect}
              onSubmitted={() => setRefreshKey((k) => k + 1)}
            />
          </div>
        </div>
      </div>

      <div className="section" style={{ marginTop: 64 }}>
        <SectionHead
          eyebrow="CANLI SONUCLAR"
          title="Sifreli veriden cikan bulgu"
          sub="Grup ortalamalari yalnizca homomorfik toplamlardan turetildi."
        />
        <div id="sonuclar">
          <Results provider={provider} refreshKey={refreshKey} />
        </div>
      </div>

      <div className="band">
        <div className="section">
          <SectionHead
            eyebrow="GUVEN AMA DOGRULA"
            title="Ayni veri, iki bagimsiz hat"
            sub="FHE hattinin dogru hesapladigini duz-metin hattiyla karsilastirarak kanitliyoruz."
          />
          <FeatureRow />
        </div>
      </div>

      <Footer />
    </div>
  );
}
