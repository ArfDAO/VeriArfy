import { userError } from "../../lib/userError";
import { useCallback, useEffect, useState } from "react";

import { CIRCUIT_WASM, CIRCUIT_ZKEY, SEPOLIA_CHAIN_ID } from "../../config";
import { getRegistry } from "../../lib/contracts";
import { enroll, getMerklePath } from "../../lib/curator";
import { formatToken, getPaymentToken, getPayments, readResearcherReadiness, type ResearcherReadiness } from "../../lib/protocol";
import { useSession } from "../../lib/session";
import {
  createIdentity,
  deserializeIdentity,
  generateProof,
  serializeIdentity,
  type Identity,
} from "../../lib/zk";

const IDENTITY_KEY = "veriarfy.researcher.identity";

type Action = "register" | "approve" | null;

function storedIdentity(): Identity | null {
  const raw = window.localStorage.getItem(IDENTITY_KEY);
  if (!raw) return null;

  try {
    return deserializeIdentity(raw);
  } catch {
    return null;
  }
}

function shortRoot(root: bigint | string) {
  const value = root.toString();
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

interface ChecklistItemProps {
  label: string;
  detail: string;
  complete: boolean;
}

function ChecklistItem({ label, detail, complete }: ChecklistItemProps) {
  return (
    <li className="researcher-setup__item">
      <span className={`researcher-setup__check${complete ? " is-complete" : ""}`} aria-hidden="true">
        {complete ? "✓" : "!"}
      </span>
      <div>
        <strong>{label}</strong>
        <p>{detail}</p>
      </div>
      <span className={`badge ${complete ? "badge--ok" : "badge--warn"}`}>
        {complete ? "tamam" : "eksik"}
      </span>
    </li>
  );
}

export function Kayit() {
  const { address, chainId, provider, signer, refresh: refreshSession } = useSession();
  const [readiness, setReadiness] = useState<ResearcherReadiness | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(storedIdentity);
  const [action, setAction] = useState<Action>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ kind: "warn" | "ok" | "info"; text: string } | null>(null);

  const wrongNetwork = chainId !== null && chainId !== SEPOLIA_CHAIN_ID;

  const refresh = useCallback(async () => {
    if (!provider || !address || chainId !== SEPOLIA_CHAIN_ID) return;
    setLoading(true);
    setNotice(null);
    try {
      setReadiness(await readResearcherReadiness(provider, address));
    } catch (error) {
      setReadiness(null);
      setNotice({
        kind: "warn",
        text: userError(error, "Hazirlik durumu zincirden okunamadi."),
      });
    } finally {
      setLoading(false);
    }
  }, [address, chainId, provider]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const register = useCallback(async () => {
    if (!provider || !signer || !address || wrongNetwork || readiness?.registered) return;
    setAction("register");
    setNotice(null);

    try {
      let nextIdentity = identity;
      if (!nextIdentity) {
        nextIdentity = createIdentity();
        window.localStorage.setItem(IDENTITY_KEY, serializeIdentity(nextIdentity));
        setIdentity(nextIdentity);
      }

      // Kurator yalnizca acik taahhudu gorur; trapdoor/nullifier tarayicidan cikmaz.
      await enroll(nextIdentity.commitment);
      const [path, chainRoot] = await Promise.all([
        getMerklePath(nextIdentity.commitment),
        getRegistry(provider).currentRoot() as Promise<bigint>,
      ]);

      // Yeni taahhut, yetkili kurator `push-root` calistirmadan zincirde kanitlanamaz.
      // Bu kontrol olmadan kullanici yalnizca `UnknownRoot` revert'i gorurdu.
      if (BigInt(path.root) !== chainRoot) {
        setNotice({
          kind: "warn",
          text: `Taahhut kuratora eklendi; ancak kurator kokunun zincire yazilmasini henuz tamamlamadi (kurator: ${shortRoot(path.root)}, zincir: ${shortRoot(chainRoot)}). Kök guncellendikten sonra yeniden deneyin.`,
        });
        return;
      }

      setNotice({ kind: "info", text: "Sifir-bilgi kaniti cihazinizda uretiliyor..." });
      const proof = await generateProof({
        identity: nextIdentity,
        merkle: {
          siblings: path.siblings,
          pathIndices: path.pathIndices,
          root: BigInt(path.root),
        },
        signerAddress: address,
        wasmUrl: CIRCUIT_WASM,
        zkeyUrl: CIRCUIT_ZKEY,
      });

      setNotice({ kind: "info", text: "Kanit zincire gonderiliyor..." });
      const transaction = await getRegistry(signer).register(
        proof.root,
        proof.nullifierHash,
        proof.a,
        proof.b,
        proof.c,
      );
      await transaction.wait();

      await refresh();
      await refreshSession();
      setNotice({ kind: "ok", text: "ZK kimlik kaydi zincirde dogrulandi." });
    } catch (error) {
      setNotice({
        kind: "warn",
        text: userError(error, "ZK kimlik kaydi basarisiz."),
      });
    } finally {
      setAction(null);
    }
  }, [address, identity, provider, readiness?.registered, refresh, refreshSession, signer, wrongNetwork]);

  const approve = useCallback(async () => {
    if (!signer || !readiness || readiness.allowance >= readiness.fee || readiness.balance < readiness.fee) return;
    setAction("approve");
    setNotice(null);
    try {
      const payments = getPayments(signer);
      const token = getPaymentToken(signer);
      const transaction = await token.approve(await payments.getAddress(), readiness.fee);
      await transaction.wait();
      await refresh();
      setNotice({ kind: "ok", text: "Sorgu ucreti icin harcama izni verildi." });
    } catch (error) {
      setNotice({
        kind: "warn",
        text: userError(error, "Harcama izni verilemedi."),
      });
    } finally {
      setAction(null);
    }
  }, [readiness, refresh, signer]);

  const balanceReady = readiness ? readiness.balance >= readiness.fee : false;
  const allowanceReady = readiness ? readiness.allowance >= readiness.fee : false;

  return (
    <section className="researcher-setup" aria-labelledby="researcher-setup-title">
      <div className="researcher-setup__heading">
        <div>
          <span className="eyebrow">ARASTIRMACI / KAYIT VE HAZIRLIK</span>
          <h1 id="researcher-setup-title">Ilk sorgudan once uc kontrol</h1>
          <p>ZK kimlik, token bakiyesi ve harcama izni zincirden yeniden okunur; tarayicida basarili varsayilmaz.</p>
        </div>
        <button className="pill pill--ghost" disabled={loading || wrongNetwork} onClick={() => void refresh()}>
          {loading ? "Okunuyor..." : "Yenile"}
        </button>
      </div>

      {wrongNetwork && (
        <div className="notice notice--warn" role="status">
          Kayit ve hazirlik denetimi yalnizca Sepolia aginda kullanilabilir.
        </div>
      )}
      {notice && <div className={`notice notice--${notice.kind}`} role="status">{notice.text}</div>}

      <div className="researcher-setup__grid">
        <article className="researcher-setup__card card">
          <span className="eyebrow">KONTROL LISTESI</span>
          <ol className="researcher-setup__list" aria-live="polite">
            <ChecklistItem
              label="ZK kimlik kaydi"
              detail={readiness?.registered ? "Arastirmaci defterinde kayitli." : "Kanitla arastirmaci defterine kaydolun."}
              complete={readiness?.registered === true}
            />
            <ChecklistItem
              label="Sorgu token bakiyesi"
              detail={readiness
                ? `${formatToken(readiness.balance, readiness.decimals, readiness.symbol)} / gerekli ${formatToken(readiness.fee, readiness.decimals, readiness.symbol)}`
                : "Zincirden okunuyor."}
              complete={balanceReady}
            />
            <ChecklistItem
              label="Harcama izni"
              detail={readiness
                ? `${formatToken(readiness.allowance, readiness.decimals, readiness.symbol)} izin / gerekli ${formatToken(readiness.fee, readiness.decimals, readiness.symbol)}`
                : "Zincirden okunuyor."}
              complete={allowanceReady}
            />
          </ol>
        </article>

        <aside className="researcher-setup__action card card--bone">
          <span className="eyebrow">SONRAKI ADIM</span>
          {!readiness?.registered ? (
            <>
              <div className="researcher-setup__action-body">
                <h2>Kimliginizi ZK ile kaydedin</h2>
                <p>Gizli kimlik tarayicida uretilir. Kurator yalnizca taahhudu gorur; zincir ise kimliginizin akredite agacta oldugunu kanitlar.</p>
              </div>
              <div className="researcher-setup__action-footer">
                <button className="pill pill--primary" disabled={action !== null || loading || wrongNetwork || !provider || !signer || !readiness} onClick={() => void register()}>
                  {action === "register" ? "Isleniyor..." : "ZK kimlik kaydini baslat"}
                </button>
                <p className="researcher-setup__action-note">Kanit cihazinizda uretilir; cüzdanda yalniz zincir kaydi imzalanir.</p>
              </div>
            </>
          ) : !balanceReady ? (
            <div className="researcher-setup__action-body">
              <h2>Token bakiyesi gerekli</h2>
              <p>Varsayilan sorgu fiyati kadar {readiness?.symbol ?? "token"} olmadan sorgu acilamaz. Bakiye geldikten sonra bu ekran otomatik olarak gercek durumu gosterecek.</p>
            </div>
          ) : !allowanceReady ? (
            <>
              <div className="researcher-setup__action-body">
                <h2>Harcama iznini verin</h2>
                <p>Yalnizca guncel varsayilan sorgu ucreti kadar izin verilir; sinirsiz token izni istenmez.</p>
              </div>
              <div className="researcher-setup__action-footer">
                <button className="pill pill--primary" disabled={action !== null || wrongNetwork || !signer} onClick={() => void approve()}>
                  {action === "approve" ? "Onaylaniyor..." : "Ucret kadar izin ver"}
                </button>
                <p className="researcher-setup__action-note">Izin tutari, zincirdeki guncel sorgu ucretini asmaz.</p>
              </div>
            </>
          ) : (
            <div className="researcher-setup__action-body">
              <h2>Arastirma cuzdani hazir</h2>
              <p>Kimlik, bakiye ve harcama izni mevcut. Veri alimi ekraninda alanlari secip anlik fiyatla sorgu acabilirsiniz.</p>
            </div>
          )}
        </aside>
      </div>

      {readiness && readiness.participants === 0 && (
        <div className="notice notice--info">
          Hazirlik kontrolleri tamamlansa bile havuzda henuz katilimci yok; bu nedenle sorgu acilamaz. Bu, kimlik veya token hatasi degildir.
        </div>
      )}
    </section>
  );
}
