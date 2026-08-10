import { useCallback, useEffect, useState } from "react";
import type { BrowserProvider } from "ethers";

import { Survey, type SurveyResult } from "./Survey";
import { getStudy, getRegistry, readParticipantState } from "../lib/contracts";
import { encryptSubmission } from "../lib/fhe";
import { createIdentity, deserializeIdentity, serializeIdentity, generateProof, type Identity } from "../lib/zk";
import { enroll, getMerklePath } from "../lib/curator";
import { CONTRACTS, CIRCUIT_WASM, CIRCUIT_ZKEY, isDeployed } from "../config";

const IDENTITY_KEY = "veriarfy.identity";

type Phase = "connect" | "identity" | "survey" | "sending" | "done";
type Note = { kind: "info" | "warn" | "ok"; text: string } | null;

interface ParticipateProps {
  provider: BrowserProvider | null;
  address: string | null;
  onConnect: () => void;
  onSubmitted: () => void;
}

export function Participate({ provider, address, onConnect, onSubmitted }: ParticipateProps) {
  const [identity, setIdentity] = useState<Identity | null>(() => {
    const raw = localStorage.getItem(IDENTITY_KEY);
    return raw ? safeDeserialize(raw) : null;
  });
  const [registered, setRegistered] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  // Zincirdeki durumu oku.
  const refreshState = useCallback(async () => {
    if (!provider || !address || !isDeployed) return;
    try {
      const state = await readParticipantState(provider, address);
      setRegistered(state.registered);
      setSubmitted(state.submitted);
    } catch {
      /* ag hatasi — sessiz gec */
    }
  }, [provider, address]);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  /** Kimlik uret + kuratore kaydol + ZK ile zincire kayit ol. */
  async function doRegister() {
    if (!provider || !address) return onConnect();
    setBusy(true);
    try {
      // 1) Kimlik
      let id = identity;
      if (!id) {
        id = createIdentity();
        localStorage.setItem(IDENTITY_KEY, serializeIdentity(id));
        setIdentity(id);
      }

      // 2) Kuratore taahhudu bildir
      setNote({ kind: "info", text: "Taahhut akredite agaca ekleniyor…" });
      await enroll(id.commitment);

      // 3) Merkle yolunu al
      const path = await getMerklePath(id.commitment);

      // 4) GERCEK zero-knowledge kanit — tarayicida uretilir
      setNote({
        kind: "info",
        text: "Sifir-bilgi kaniti uretiliyor… (birkac saniye surebilir)",
      });
      const proof = await generateProof({
        identity: id,
        merkle: {
          siblings: path.siblings,
          pathIndices: path.pathIndices,
          root: BigInt(path.root),
        },
        signerAddress: address,
        wasmUrl: CIRCUIT_WASM,
        zkeyUrl: CIRCUIT_ZKEY,
      });

      // 5) Zincire kayit
      setNote({ kind: "info", text: "Kanit zincire gonderiliyor…" });
      const signer = await provider.getSigner();
      const tx = await getRegistry(signer).register(
        proof.root,
        proof.nullifierHash,
        proof.a,
        proof.b,
        proof.c,
      );
      await tx.wait();

      setRegistered(true);
      setNote({
        kind: "ok",
        text: "Kimlik dogrulandi. Kim oldugunuz zincire hic yazilmadi.",
      });
    } catch (err: any) {
      setNote({ kind: "warn", text: err?.message ?? "Kayit basarisiz." });
    } finally {
      setBusy(false);
    }
  }

  /** Anket sonucunu FHE ile sifreleyip gonder. */
  async function doSubmit(result: SurveyResult) {
    if (!provider || !address) return onConnect();
    setBusy(true);
    try {
      setNote({ kind: "info", text: "Yanitlar cihazinizda sifreleniyor…" });
      const enc = await encryptSubmission({
        contractAddress: CONTRACTS.AnxietyStudy,
        userAddress: address,
        group: result.group,
        anxiety: result.anxiety,
        panic: result.panic,
      });

      setNote({ kind: "info", text: "Sifreli yanit zincire gonderiliyor…" });
      const signer = await provider.getSigner();
      const tx = await getStudy(signer).submit(
        enc.handles[0],
        enc.handles[1],
        enc.handles[2],
        enc.inputProof,
      );
      await tx.wait();

      setSubmitted(true);
      setNote({
        kind: "ok",
        text: "Katkiniz sifreli olarak eklendi. Tesekkurler.",
      });
      onSubmitted();
    } catch (err: any) {
      setNote({ kind: "warn", text: err?.message ?? "Gonderim basarisiz." });
    } finally {
      setBusy(false);
    }
  }

  // --- Goruntuleme --------------------------------------------------------

  if (!isDeployed) {
    return (
      <div className="card card--bone">
        <span className="eyebrow eyebrow--12">KATILIM</span>
        <h3 style={{ marginTop: 12 }}>Kontratlar heniz deploy edilmedi</h3>
        <p className="card__body" style={{ marginTop: 8 }}>
          <code>npm run contracts:deploy:sepolia</code> calistirdiktan sonra
          katilim acilir. Bu arada dogrulama koşumunu{" "}
          <code>npm run study:verify</code> ile yerelde calistirabilirsiniz.
        </p>
      </div>
    );
  }

  if (!address) {
    return (
      <div className="card card--bone" style={{ textAlign: "center" }}>
        <span className="eyebrow eyebrow--12">KATILIM</span>
        <h3 style={{ marginTop: 12 }}>Once cuzdaninizi baglayin</h3>
        <p className="card__body" style={{ marginTop: 8, marginBottom: 20 }}>
          Kimliginiz acilmadan katilim hakkinizi kanitlamak icin gereklidir.
        </p>
        <button className="pill pill--primary" onClick={onConnect}>
          Cuzdan bagla
        </button>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="card card--bone" style={{ textAlign: "center" }}>
        <span className="eyebrow eyebrow--12">KATILIM TAMAM</span>
        <h3 style={{ marginTop: 12 }}>Yanitiniz sifreli olarak sayildi</h3>
        <p className="card__body" style={{ marginTop: 8 }}>
          Puanlariniz yalnizca grup toplamina katildi. Ne siz ne de arastirmaci
          bireysel degeri geri cozebilir. Sonuclari asagida gorebilirsiniz.
        </p>
      </div>
    );
  }

  if (!registered) {
    return (
      <div className="card card--bone">
        <div className="card__head">
          <span className="eyebrow eyebrow--12">ADIM 0 · ZK KIMLIK</span>
          <span className="badge">
            <span className="badge__dot badge__dot--off" />
            dogrulanmadi
          </span>
        </div>
        <h3>Kimliginizi acmadan katilim hakkinizi kanitlayin</h3>
        <p className="card__body" style={{ marginTop: 8 }}>
          Cihazinizda bir gizli kimlik uretilir. Zincire yalnizca "bu kisi
          akredite listede" bilgisi gider; hangi kisi oldugunuz gitmez. Ayni
          kimlik ikinci kez katilamaz (nullifier).
        </p>
        <div style={{ marginTop: 20 }}>
          <button className="pill pill--primary" onClick={doRegister} disabled={busy}>
            {busy ? "Isleniyor…" : "Kimligimi dogrula"}
          </button>
        </div>
        {note && <div className={`notice notice--${note.kind}`}>{note.text}</div>}
      </div>
    );
  }

  return (
    <>
      <Survey onComplete={doSubmit} disabled={busy} />
      {note && (
        <div className={`notice notice--${note.kind}`} style={{ marginTop: 16 }}>
          {note.text}
        </div>
      )}
    </>
  );
}

function safeDeserialize(raw: string): Identity | null {
  try {
    return deserializeIdentity(raw);
  } catch {
    return null;
  }
}
