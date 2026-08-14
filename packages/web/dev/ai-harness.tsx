/**
 * Sifreli AI hattinin KRIPTO DISI kismini gercek verilerle dogrular.
 *
 * Mock yok: gercek 1000 Genomes dosyasi aga gidip indirilir, gercek Rust
 * parser ayristirir, gercek ML sunucusundan gercek panel cekilir ve hizalama
 * gercek wasm `selectPanel` ile yapilir.
 *
 * Sifreleme adimi burada YOK — cunku `concrete-ml`'in tarayici istemcisi
 * yayinlanmis degil. Sahte bir sifreleyici koymak yerine o adim acikta
 * birakilmistir.
 */

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { useVcfParser } from "../src/lib/useVcfParser";
import { useFheAi } from "../src/lib/useFheAi";
import { FheAiError } from "../src/lib/fheAiClient";

const VCF_URL =
  "https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/release/20130502/" +
  "ALL.chrMT.phase3_callmom-v0_4.20130502.genotypes.vcf.gz";

const SUBJECT = "HG02922";

interface Case {
  name: string;
  ok: boolean;
  detail: string;
}

function Harness() {
  const vcf = useVcfParser();
  const ai = useFheAi();

  const [cases, setCases] = useState<Case[]>([]);
  const [phase, setPhase] = useState("gercek VCF indiriliyor…");
  const [done, setDone] = useState(false);
  const fetched = useRef(false);
  const ran = useRef(false);
  /** Panel geldiginde dogrulamalar tek sefer kosmali: `ai` durumu degistikce
   *  effect yeniden tetiklenir. */
  const checked = useRef(false);

  const add = (name: string, ok: boolean, detail = "") =>
    setCases((prev) => [...prev, { name, ok, detail }]);

  // 1) Gercek dosyayi 1000 Genomes'tan indir, BGZF'i tarayicida ac.
  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;

    (async () => {
      try {
        const response = await fetch(VCF_URL);
        add("1000 Genomes'a dogrudan erisim (CORS)", response.ok, `HTTP ${response.status}`);

        const compressed = await response.blob();
        add("gercek dosya indi", compressed.size > 0, `${(compressed.size / 1024).toFixed(0)} KB (bgzip)`);

        // BGZF'i worker'in kendi cozucusu acar (DecompressionStream tek basina
        // cok-uyeli bgzip'te kiriliyor — bu gercek dosyayla olculdu).
        setPhase("Faz 1: gercek bgzip VCF aciliyor ve ayristiriliyor…");
        vcf.parse(new File([compressed], "chrMT.vcf.gz"), SUBJECT);
      } catch (e) {
        add("gercek VCF alinamadi", false, (e as Error).message);
        setDone(true);
      }
    })();
  }, [vcf]);

  // 2) Dozajlar hazir olunca gercek sunucunun paneliyle hizala.
  useEffect(() => {
    if (!vcf.result || ran.current) return;
    ran.current = true;

    (async () => {
      try {
        const dosages = vcf.result!.dosages;
        add(
          `Faz 1: ${SUBJECT} ayristirildi`,
          vcf.result!.sampleName === SUBJECT && dosages.length > 3000,
          `${vcf.result!.variantCount} varyant, ornek ${vcf.result!.sampleName}`,
        );

        setPhase("ML sunucusundan panel cekiliyor…");
        await ai.refresh();
      } catch (e) {
        add("panel cekilemedi", false, (e as Error).message);
        setDone(true);
      }
    })();
  }, [vcf.result, ai]);

  // 3) Panel gelince hizalamayi ve dogrulamalari kos.
  useEffect(() => {
    if (!ai.panel || !vcf.result || checked.current) return;
    checked.current = true;

    try {
      const dosages = vcf.result.dosages;
      const panel = ai.panel;

      add(
        "gercek ML sunucusundan panel alindi",
        panel.panel_indices.length > 0,
        `${panel.panel_indices.length} varyant · ${panel.label}`,
      );
      add(
        "saglik raporu gercek egitim metrikleri tasiyor",
        Boolean(ai.health?.ready) && Number(ai.health?.report?.["roc_auc"]) > 0.9,
        `${ai.health?.report?.["n_samples"]} birey · auc ${Number(ai.health?.report?.["roc_auc"]).toFixed(3)}`,
      );

      // --- ASIL DOGRULAMA: hizalama ---
      const aligned = ai.preview(dosages);
      const expected = panel.panel_indices.map((i) => dosages[i]);
      add(
        "panel hizalamasi birebir dogru (sunucunun sirasiyla)",
        aligned.length === expected.length && Array.from(aligned).every((v, i) => v === expected[i]),
        `[${Array.from(aligned).join(",")}]`,
      );
      add(
        "hizalanan degerler 0/1/2 alaninda",
        Array.from(aligned).every((v) => v <= 2),
        `${aligned.length} varyant`,
      );

      // --- Bozuk girdi sessizce gecmemeli ---
      let shortVectorRejected = false;
      try {
        ai.preview(dosages.slice(0, 10));
      } catch (e) {
        shortVectorRejected = e instanceof FheAiError;
      }
      add("kisa/uyumsuz dozaj vektoru reddedildi", shortVectorRejected);

      // --- Sifreleyici olmadan analiz calismamali (sahte kripto yok) ---
      (async () => {
        let refused = "";
        try {
          await ai.analyze(dosages, undefined as never);
        } catch (e) {
          refused = (e as Error).message;
        }
        add(
          "sifreleyici olmadan analiz REDDEDILDI (sahte kripto yok)",
          refused.length > 0,
          refused.slice(0, 70),
        );
        setPhase("bitti");
        setDone(true);
      })();
    } catch (e) {
      add("BEKLENMEDIK HATA", false, (e as Error).message);
      setDone(true);
    }
  }, [ai, vcf.result]);

  const pass = cases.filter((c) => c.ok).length;
  const fail = cases.length - pass;

  return (
    <>
      <h1>VeriArfy · sifreli AI hatti</h1>
      <p className="sub">
        Gerçek 1000 Genomes dosyası · gerçek parser · gerçek ML sunucusu. Durum: {phase}
      </p>

      <section>
        <h2>DOGRULAMALAR</h2>
        {cases.map((c, i) => (
          <div className="case" key={i}>
            <span className={`badge ${c.ok ? "ok" : "fail"}`}>{c.ok ? "GECTI" : "KALDI"}</span>
            <span className="name">{c.name}</span>
            <span className="val">{c.detail}</span>
          </div>
        ))}
      </section>

      {(vcf.error || ai.error) && (
        <section>
          <h2>HATA</h2>
          <div className="val">{vcf.error ?? ai.error}</div>
        </section>
      )}

      {done && (
        <div
          id="verdict"
          style={{
            background: fail === 0 ? "#16301f" : "#3a1a16",
            color: fail === 0 ? "#57c99a" : "#e8654f",
          }}
        >
          {fail === 0
            ? `TUM DOGRULAMALAR GECTI — ${pass}/${cases.length}`
            : `${fail} DOGRULAMA BASARISIZ — ${pass}/${cases.length}`}
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
