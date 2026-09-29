import { userError } from "../../lib/userError";
import { useCallback, useEffect, useState } from "react";

import { CIRCUIT_WASM, CIRCUIT_ZKEY, SEPOLIA_CHAIN_ID } from "../../config";
import { getRegistry } from "../../lib/contracts";
import { CURATOR_SLOW_MS, enroll, getMerklePath } from "../../lib/curator";
import { formatToken, getPaymentToken, getPayments, readResearcherReadiness, type ResearcherReadiness } from "../../lib/protocol";
import { useSession } from "../../lib/session";
import {
  EXTERNAL_NULLIFIER,
  computeNullifierHash,
  createIdentity,
  deserializeIdentity,
  generateProof,
  serializeIdentity,
  type Identity,
} from "../../lib/zk";
import { useT } from "../../lib/i18n";

/**
 * ZK kimligi CUZDAN BASINA saklanir.
 *
 * Eskiden tek bir sabit anahtar vardi ve kimlik tarayici basina tutuluyordu.
 * Sonucu: bir cuzdanla kaydolduktan sonra MetaMask'te hesap degistirip tekrar
 * denemek AYNI nullifier'i ikinci kez harcamaya calisiyor, zincir
 * `NullifierAlreadySpent` ile reddediyordu. Yani "birden fazla hesapla giris"
 * tarayicinin kendisi yuzunden imkansizdi ve hata mesaji bunu soylemiyordu.
 *
 * Nullifier tek kullanimlik oldugu icin her cuzdanin kendi kimligi olmak
 * zorunda; anahtar adresle isimlendiriliyor.
 */
const IDENTITY_PREFIX = "veriarfy.researcher.identity";
const LEGACY_IDENTITY_KEY = IDENTITY_PREFIX;

function identityKey(address: string): string {
  return `${IDENTITY_PREFIX}.${address.toLowerCase()}`;
}

// Kok yazma islemi Sepolia'da tipik olarak 15-30 saniye surer; 12 x 5 sn = 60 sn
// pencere, yogun blok zamanlarinda da yetiyor ve kullaniciyi bosa bekletmiyor.
const ROOT_WAIT_ATTEMPTS = 12;
const ROOT_WAIT_INTERVAL_MS = 5_000;

type Action = "register" | "approve" | null;

function storedIdentity(address: string | null | undefined): Identity | null {
  if (!address) return null;

  const raw = window.localStorage.getItem(identityKey(address));
  if (!raw) return null;

  try {
    return deserializeIdentity(raw);
  } catch {
    return null;
  }
}

function legacyIdentity(): Identity | null {
  const raw = window.localStorage.getItem(LEGACY_IDENTITY_KEY);
  if (!raw) return null;

  try {
    return deserializeIdentity(raw);
  } catch {
    window.localStorage.removeItem(LEGACY_IDENTITY_KEY);
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
  const t = useT();
  const { address, chainId, provider, signer, refresh: refreshSession } = useSession();
  const [readiness, setReadiness] = useState<ResearcherReadiness | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);

  // Cuzdan degisince kimlik de degismeli; aksi halde yeni hesap eski hesabin
  // harcanmis nullifier'iyla kaydolmaya calisir.
  //
  // Tek anahtarli surumden gecis burada yapiliyor ve ZINCIRE SORULUYOR. Eski
  // kimligi kosulsuz devralmak yanlis olurdu: o kimlik baska bir cuzdanla
  // kaydolmus olabilir, nullifier'i harcanmistir ve devralan cuzdan her
  // denemede `NullifierAlreadySpent` alir - tam da duzeltmeye calistigimiz
  // hatanin aynisi. Harcanmamissa devralinir (kullanici kaydini kaybetmesin),
  // harcanmissa atilir: kayit zincirde kalici oldugu icin harcanmis bir
  // kimligin baska bir isi kalmaz.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!address) {
        setIdentity(null);
        return;
      }

      const own = storedIdentity(address);
      if (own) {
        if (!cancelled) setIdentity(own);
        return;
      }

      const legacy = legacyIdentity();
      if (!legacy) {
        if (!cancelled) setIdentity(null);
        return;
      }

      // Zincire soramiyorsak eski kimligi TASIMIYORUZ. Yanlis tarafa dusmek
      // kullaniciyi cozumu olmayan bir hataya kilitler; tasimamak ise en
      // fazla yeni bir kimlik uretilmesine yol acar.
      if (!provider || chainId !== SEPOLIA_CHAIN_ID) {
        if (!cancelled) setIdentity(null);
        return;
      }

      try {
        const hash = computeNullifierHash(EXTERNAL_NULLIFIER, legacy.nullifier);
        const spent = (await getRegistry(provider).nullifierSpent(hash)) as boolean;
        if (cancelled) return;

        if (spent) {
          window.localStorage.removeItem(LEGACY_IDENTITY_KEY);
          setIdentity(null);
          return;
        }

        window.localStorage.setItem(identityKey(address), serializeIdentity(legacy));
        window.localStorage.removeItem(LEGACY_IDENTITY_KEY);
        setIdentity(legacy);
      } catch {
        if (!cancelled) setIdentity(null);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [address, chainId, provider]);
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
        window.localStorage.setItem(identityKey(address), serializeIdentity(nextIdentity));
        setIdentity(nextIdentity);
      }

      // Barindirilan kurator hareketsizlikte uyutuluyor ve ilk istek uyanmayi
      // bekliyor (~35 sn). Bu sure boyunca ekranda yalnizca "Isleniyor..."
      // yaziyordu; kullanicinin bunu donmus saymamasi icin sebebini soyluyoruz.
      // Mesaj yalnizca cagri GERCEKTEN uzarsa cikar, hizli yanitta hic gorunmez.
      const slowTimer = setTimeout(() => {
        setNotice({ kind: "info", text: t("Kurator servisi uyaniyor, bu ilk istekte yarim dakikayi bulabilir...") });
      }, CURATOR_SLOW_MS);

      // Kurator yalnizca acik taahhudu gorur; trapdoor/nullifier tarayicidan cikmaz.
      let enrollment;
      try {
        enrollment = await enroll(nextIdentity.commitment);
      } finally {
        clearTimeout(slowTimer);
      }
      const path = await getMerklePath(nextIdentity.commitment);
      const registry = getRegistry(provider);

      // Yeni taahhut, kok zincire yazilmadan kanitlanamaz; yazilmadan devam
      // edilirse kullanici yalnizca anlamsiz bir `UnknownRoot` revert'i gorur.
      //
      // Kurator kokU kendisi yaziyorsa islem birkac blok surer, bu yuzden
      // hemen vazgecmek yerine kisa bir sure bekleyip zinciri yeniden okuyoruz.
      // Yazma yetkisi yoksa (`rootPending`) beklemenin anlami yok - o durum
      // kullanicinin degil operatorun cozecegi bir eksiklik.
      const treeRoot = BigInt(path.root);
      let chainRoot = (await registry.currentRoot()) as bigint;

      if (treeRoot !== chainRoot && enrollment.rootPending !== true) {
        setNotice({
          kind: "info",
          text: t("Kurator kokunu zincire yaziyor, onaylanmasi bekleniyor..."),
        });
        for (let attempt = 0; attempt < ROOT_WAIT_ATTEMPTS && treeRoot !== chainRoot; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, ROOT_WAIT_INTERVAL_MS));
          chainRoot = (await registry.currentRoot()) as bigint;
        }
      }

      if (treeRoot !== chainRoot) {
        setNotice({
          kind: "warn",
          text:
            enrollment.rootPending === true
              ? t(
                  "Taahhudunuz kurator agacina eklendi (sira #{index}), ancak kurator servisi kokU zincire yazma yetkisine sahip degil. Bu, sizin tamamlayabileceginiz bir adim degil: operatorun kok yazma yetkisini kurator cuzdanina devretmesi gerekiyor. Devir tamamlandiktan sonra bu sayfadan tekrar deneyin; taahhudunuz korunuyor, bastan olusturmaniz gerekmez.",
                  { index: enrollment.index },
                )
              : t(
                  "Taahhut kuratora eklendi ancak kok zincirde henuz guncellenmedi (kurator: {tree}, zincir: {chain}). Birkac dakika sonra yeniden deneyin.",
                  { tree: shortRoot(path.root), chain: shortRoot(chainRoot) },
                ),
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
          <span className="eyebrow">{t("ARASTIRMACI / KAYIT VE HAZIRLIK")}</span>
          <h1 id="researcher-setup-title">{t("Ilk sorgudan once uc kontrol")}</h1>
          <p>{t("ZK kimlik, token bakiyesi ve harcama izni zincirden yeniden okunur; tarayicida basarili varsayilmaz.")}</p>
        </div>
        <button className="pill pill--ghost" disabled={loading || wrongNetwork} onClick={() => void refresh()}>
          {loading ? t("Okunuyor...") : t("Yenile")}
        </button>
      </div>

      {wrongNetwork && (
        <div className="notice notice--warn" role="status">
          {t("Kayit ve hazirlik denetimi yalnizca Sepolia aginda kullanilabilir.")}
        </div>
      )}
      {notice && <div className={`notice notice--${notice.kind}`} role="status">{notice.text}</div>}

      <div className="researcher-setup__grid">
        <article className="researcher-setup__card card">
          <span className="eyebrow">{t("KONTROL LISTESI")}</span>
          <ol className="researcher-setup__list" aria-live="polite">
            <ChecklistItem
              label={t("ZK kimlik kaydi")}
              detail={readiness?.registered ? t("Arastirmaci defterinde kayitli.") : t("Kanitla arastirmaci defterine kaydolun.")}
              complete={readiness?.registered === true}
            />
            <ChecklistItem
              label={t("Sorgu token bakiyesi")}
              detail={readiness
                ? `${formatToken(readiness.balance, readiness.decimals, readiness.symbol)} / gerekli ${formatToken(readiness.fee, readiness.decimals, readiness.symbol)}`
                : "Zincirden okunuyor."}
              complete={balanceReady}
            />
            <ChecklistItem
              label={t("Harcama izni")}
              detail={readiness
                ? `${formatToken(readiness.allowance, readiness.decimals, readiness.symbol)} izin / gerekli ${formatToken(readiness.fee, readiness.decimals, readiness.symbol)}`
                : "Zincirden okunuyor."}
              complete={allowanceReady}
            />
          </ol>
        </article>

        <aside className="researcher-setup__action card card--bone">
          <span className="eyebrow">{t("SONRAKI ADIM")}</span>
          {!readiness?.registered ? (
            <>
              <div className="researcher-setup__action-body">
                <h2>{t("Kimliginizi ZK ile kaydedin")}</h2>
                <p>{t("Gizli kimlik tarayicida uretilir. Kurator yalnizca taahhudu gorur; zincir ise kimliginizin akredite agacta oldugunu kanitlar.")}</p>
              </div>
              <div className="researcher-setup__action-footer">
                <button className="pill pill--primary" disabled={action !== null || loading || wrongNetwork || !provider || !signer || !readiness} onClick={() => void register()}>
                  {action === "register" ? t("Isleniyor...") : t("ZK kimlik kaydini baslat")}
                </button>
                <p className="researcher-setup__action-note">{t("Kanit cihazinizda uretilir; cüzdanda yalniz zincir kaydi imzalanir.")}</p>
              </div>
            </>
          ) : !balanceReady ? (
            <div className="researcher-setup__action-body">
              <h2>{t("Token bakiyesi gerekli")}</h2>
              <p>Varsayilan sorgu fiyati kadar {readiness?.symbol ?? "token"} olmadan sorgu acilamaz. Bakiye geldikten sonra bu ekran otomatik olarak gercek durumu gosterecek.</p>
            </div>
          ) : !allowanceReady ? (
            <>
              <div className="researcher-setup__action-body">
                <h2>{t("Harcama iznini verin")}</h2>
                <p>{t("Yalnizca guncel varsayilan sorgu ucreti kadar izin verilir; sinirsiz token izni istenmez.")}</p>
              </div>
              <div className="researcher-setup__action-footer">
                <button className="pill pill--primary" disabled={action !== null || wrongNetwork || !signer} onClick={() => void approve()}>
                  {action === "approve" ? t("Onaylaniyor...") : t("Ucret kadar izin ver")}
                </button>
                <p className="researcher-setup__action-note">{t("Izin tutari, zincirdeki guncel sorgu ucretini asmaz.")}</p>
              </div>
            </>
          ) : (
            <div className="researcher-setup__action-body">
              <h2>{t("Arastirma cuzdani hazir")}</h2>
              <p>{t("Kimlik, bakiye ve harcama izni mevcut. Veri alimi ekraninda alanlari secip anlik fiyatla sorgu acabilirsiniz.")}</p>
            </div>
          )}
        </aside>
      </div>

      {readiness && readiness.participants === 0 && (
        <div className="notice notice--info">
          {t("Hazirlik kontrolleri tamamlansa bile havuzda henuz katilimci yok; bu nedenle sorgu acilamaz. Bu, kimlik veya token hatasi degildir.")}
        </div>
      )}
    </section>
  );
}
