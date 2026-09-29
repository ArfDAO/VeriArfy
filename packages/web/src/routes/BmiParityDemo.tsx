import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Contract, formatEther, getAddress, parseEther } from "ethers";

import {
  BMI_DEMO_CONTRACT,
  BMI_DEMO_LIVE_PROOF,
  SEPOLIA_CHAIN_ID,
  explorerAddress,
  explorerTx,
  isBmiDemoDeployed,
} from "../config";
import { BMI_DEMO_ABI } from "../config/abi";
import { encryptBmiDemoWeight, publicDecrypt } from "../lib/fhe";
import { useSession } from "../lib/session";
import { userError } from "../lib/userError";

interface BmiInput {
  heightCm: number;
  weightDeciKg: number;
  bmiX100: number;
}

function parseBmiInput(heightText: string, weightText: string): BmiInput | null {
  const heightCm = Number(heightText);
  const weightKg = Number(weightText.replace(",", "."));
  const weightDeciKg = Math.round(weightKg * 10);
  if (!Number.isInteger(heightCm) || heightCm < 100 || heightCm > 250 ||
      !Number.isFinite(weightKg) || weightDeciKg < 1 || weightDeciKg > 3000) return null;
  return {
    heightCm,
    weightDeciKg,
    bmiX100: Math.floor((weightDeciKg * 100_000) / (heightCm * heightCm)),
  };
}

function formatBmi(value: number | null) {
  return value === null ? "—" : (value / 100).toFixed(2);
}

function technicalMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return typeof error === "string" ? error : null;
  const value = error as {
    shortMessage?: unknown;
    message?: unknown;
    info?: { error?: { message?: unknown } };
  };
  const message = value.shortMessage ?? value.info?.error?.message ?? value.message;
  return typeof message === "string" && message.trim() ? message.slice(0, 500) : null;
}

// Gercek Sepolia FHE islemi icin olculen gas ~0.0008 SepETH'tir. Bu esik,
// fee dalgalanmasinda kullanicinin imzadan sonra anlamsiz "insufficient funds"
// hatasi gormemesi icin bilerek pay birakir.
const MIN_DEMO_SEPOLIA_BALANCE = parseEther("0.003");

/**
 * Real fhEVM BMI parity demo.
 *
 * The browser computes a plaintext reference, then encrypts weight for the
 * separate synthetic-only demo contract. The contract uses homomorphic
 * multiplication and division to calculate BMI x100. Its public result is a
 * deliberate demo exception, never an E/18 research-data disclosure.
 */
export function BmiParityDemo() {
  const { address, chainId, signer, connect, error: sessionError, switchToSepolia } = useSession();
  const [height, setHeight] = useState("175");
  const [weight, setWeight] = useState("72,4");
  const [busy, setBusy] = useState(false);
  const [fheBmi, setFheBmi] = useState<number | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn" | "info"; text: string } | null>(null);
  const [technicalError, setTechnicalError] = useState<string | null>(null);
  const input = useMemo(() => parseBmiInput(height, weight), [height, weight]);
  const wrongNetwork = chainId !== null && chainId !== SEPOLIA_CHAIN_ID;
  const parity = input !== null && fheBmi !== null ? input.bmiX100 === fheBmi : null;

  const calculateOnFhe = async () => {
    if (!input || !address || !signer || !isBmiDemoDeployed) return;
    const walletProvider = signer.provider;
    if (!walletProvider) {
      setNotice({ kind: "warn", text: "Cüzdan sağlayıcısı okunamadı. Rabby bağlantısını yenileyip tekrar deneyin." });
      return;
    }
    try {
      const balance = await walletProvider.getBalance(address);
      if (balance < MIN_DEMO_SEPOLIA_BALANCE) {
        setNotice({
          kind: "warn",
          text: `Canlı FHE işlemi için Rabby hesabında en az 0.003 SepETH gerekli. Mevcut bakiye: ${formatEther(balance)} SepETH.`,
        });
        return;
      }
    } catch {
      setNotice({ kind: "warn", text: "Sepolia cüzdan bakiyesi okunamadı. Rabby ağını ve bağlantısını kontrol edin." });
      return;
    }
    setBusy(true);
    setFheBmi(null);
    setTxHash(null);
    setTechnicalError(null);
    setNotice({ kind: "info", text: "Ağırlık fhEVM girdisi olarak şifreleniyor…" });
    try {
      const encrypted = await encryptBmiDemoWeight({
        contractAddress: BMI_DEMO_CONTRACT,
        // Eski/aktif oturumda adres kucuk harfli kalmis olsa bile FHE SDK'ya
        // EIP-55 checksum formunu veririz; SDK bunu zorunlu tutar.
        userAddress: getAddress(address),
        weightDeciKg: input.weightDeciKg,
      });
      const contract = new Contract(BMI_DEMO_CONTRACT, BMI_DEMO_ABI, signer);
      setNotice({ kind: "info", text: "Şifreli ağırlıktan BMI, Sepolia fhEVM üzerinde hesaplanıyor…" });
      const tx = await contract.calculate(encrypted.handle, input.heightCm, encrypted.inputProof);
      const receipt = await tx.wait();
      setTxHash(receipt.hash);

      // The coprocessor may need time after the transaction is mined. Never
      // replace that asynchronous FHE result with a local fallback.
      const handle = await contract.bmiHandle(address) as string;
      let clear: bigint | null = null;
      let lastError: unknown;
      for (let attempt = 0; attempt < 12 && clear === null; attempt++) {
        try {
          const values = await publicDecrypt([handle]);
          clear = values[handle.toLowerCase()] ?? null;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        }
      }
      if (clear === null) throw lastError ?? new Error("FHE sonucu henüz çözülemedi");
      setFheBmi(Number(clear));
      setNotice({ kind: "ok", text: "Gerçek fhEVM sonucu çözüldü; aşağıdaki değer plaintext referansla karşılaştırıldı." });
    } catch (error) {
      setTechnicalError(technicalMessage(error));
      setNotice({ kind: "warn", text: userError(error, "FHE BMI hesaplaması tamamlanamadı.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="bmi-demo">
      <nav className="bmi-demo__nav section" aria-label="Demo navigasyonu">
        <Link className="panel-shell__brand" to="/"><span className="panel-shell__mark">V</span>veriarfy</Link>
        <Link className="nav__link" to="/">Ana sayfaya dön</Link>
      </nav>

      <section className="bmi-demo__hero section" aria-labelledby="bmi-demo-title">
        <div>
          <span className="eyebrow">TEKNOFEST / CANLI FHE BMI DEMOSU</span>
          <h1 id="bmi-demo-title">Aynı BMI,<br /><em>iki hesap hattı.</em></h1>
          <p>Önce açık referans hesaplanır. Sonra ağırlık şifrelenir; VeriArfy’nin ayrı demo kontratı BMI’yi fhEVM içinde hesaplar ve yalnızca bu sentetik demo için sonucu çözer.</p>
        </div>
        <aside className="bmi-demo__scope card card--bone">
          <span className="eyebrow">AÇIK SINIR</span>
          <strong>Sentetik jüri demosu</strong>
          <p>Bu kontrat E/18 araştırma havuzundan ayrıdır. Ağırlık şifrelidir; boy açık bölendir; final BMI demo istisnası olarak public-decryptable’dır. Gerçek kişi verisi girmeyin.</p>
        </aside>
      </section>

      <section className="bmi-demo__body section" aria-label="BMI hesaplayıcı">
        <article className="bmi-demo__verification is-pass">
          <span className="eyebrow">SEPOLIA ZİNCİR KANITI / SENTETİK TEST</span>
          <h2>{BMI_DEMO_LIVE_PROOF.weightKg} kg · {BMI_DEMO_LIVE_PROOF.heightCm} cm → iki hatta da {BMI_DEMO_LIVE_PROOF.bmi}</h2>
          <p>Bu sabit örnek, canlı kontratta relayer ile şifrelenip hesaplandı; aşağıdaki bağlantılar aynı zincir işlemine gider. Hesaplayıcıda girilen yeni değerler ise cüzdanla ayrı bir canlı işlem başlatır.</p>
          <div className="bmi-demo__replay">
            <a className="bmi-demo__tx mono" href={explorerTx(BMI_DEMO_LIVE_PROOF.transactionHash)} target="_blank" rel="noreferrer">Canlı FHE işlem kaydını aç ↗</a>
            <a className="bmi-demo__tx mono" href={explorerAddress(BMI_DEMO_CONTRACT)} target="_blank" rel="noreferrer">Demo kontratını aç ↗</a>
          </div>
        </article>
        {!isBmiDemoDeployed && <div className="notice notice--warn"><strong>Canlı kontrat henüz deploy edilmedi.</strong> Bu sayfa FHE işlemi başlatmaz; Sepolia adresi yayınlanana kadar yalnızca plaintext referansı gösterebilir.</div>}
        <article className="bmi-demo__calculator card">
          <div><span className="eyebrow">1 / AÇIK REFERANS</span><h2>BMI hesaplayıcı</h2><p>Formül: ağırlık (kg) / boy² (m). Zincirde tam sayı hesap için ağırlık kg×10, sonuç BMI×100 olarak temsil edilir.</p></div>
          <div className="bmi-demo__fields">
            <label className="field">Boy (cm)<input inputMode="numeric" value={height} onChange={(event) => setHeight(event.target.value)} /></label>
            <label className="field">Ağırlık (kg)<input inputMode="decimal" value={weight} onChange={(event) => setWeight(event.target.value)} /></label>
          </div>
          {!input && <p className="notice notice--warn">Boy 100–250 cm, ağırlık 0,1–300,0 kg olmalı.</p>}
          <div className="bmi-demo__result-card"><span>ŞİFRESİZ BMI</span><strong>{formatBmi(input?.bmiX100 ?? null)}</strong><small>kg/m²</small></div>
        </article>

        <article className="bmi-demo__calculator bmi-demo__calculator--fhe card">
          <div><span className="eyebrow">2 / VERİARFY fhEVM</span><h2>Şifreli ağırlıktan BMI hesapla</h2><p>Tarayıcı yalnızca ağırlığı şifreler. Kontrat <span className="mono">encryptedWeight × 100000 ÷ heightCm²</span> işlemini FHE üzerinde yürütür.</p></div>
          {!address && <button className="pill pill--primary" type="button" onClick={() => void connect()} disabled={!isBmiDemoDeployed}>Cüzdanı bağla</button>}
          {address && wrongNetwork && <button className="pill pill--primary" type="button" onClick={() => void switchToSepolia()} disabled={!isBmiDemoDeployed}>Sepolia’ya geç</button>}
          {address && !wrongNetwork && <button className="pill pill--primary" type="button" onClick={() => void calculateOnFhe()} disabled={!input || !isBmiDemoDeployed || busy}>{busy ? "FHE hesaplanıyor…" : "Şifrele ve canlı hesapla"}</button>}
          {sessionError && <p className="notice notice--warn" role="status">{sessionError}</p>}
          {notice && <p className={`notice notice--${notice.kind}`} role="status">{notice.text}</p>}
          {technicalError && <details className="bmi-demo__technical-error"><summary>Teknik hata ayrıntısı</summary><code>{technicalError}</code></details>}
          <div className="bmi-demo__result-card"><span>FHE BMI</span><strong>{formatBmi(fheBmi)}</strong><small>kg/m²</small></div>
          {txHash && <a className="bmi-demo__tx mono" href={`https://sepolia.etherscan.io/tx/${txHash}`} target="_blank" rel="noreferrer">Sepolia işlemini aç ↗</a>}
        </article>

        <article className={`bmi-demo__verification ${parity === true ? "is-pass" : parity === false ? "is-fail" : ""}`} aria-live="polite">
          <span className="eyebrow">3 / PARITY</span>
          <h2>{parity === true ? "PASS — plaintext ve fhEVM BMI aynı" : parity === false ? "FAIL — değerler uyuşmuyor" : "FHE sonucu bekleniyor"}</h2>
          <p>{parity === null ? "Canlı FHE hesaplaması tamamlandığında iki sonuç burada karşılaştırılır." : `Δ BMI×100 = ${(fheBmi ?? 0) - (input?.bmiX100 ?? 0)}`}</p>
        </article>
      </section>
    </main>
  );
}
