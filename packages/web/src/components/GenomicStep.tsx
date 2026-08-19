import { useCallback, useMemo, useRef, useState } from "react";
import type { Signer } from "ethers";

import { alignToPanel, DOSAGE_MISSING, type GenotypeCall } from "../lib/panel";
import { detectFormat, parseConsumerFile } from "../lib/consumerGenotype";
import { GENOMIC_PANEL } from "../lib/studyPanel";
import { contributeDosages } from "../lib/protocol";
import { useVcfParser } from "../lib/useVcfParser";
import type { TraceApi } from "../lib/useTrace";
import { noteEvidence, txEvidence, valueEvidence } from "../lib/trace";

/**
 * Veri kategorisi 1 — genomik dosya.
 *
 * # Uc bicim, tek cikti
 *
 *   VCF          arastirma/klinik standardi (wasm akis ayristirici)
 *   23andMe      sekmeli duz metin, genotip TEK sutunda  (AG)
 *   AncestryDNA  sekmeli duz metin, genotip IKI sutunda  (A, G)
 *
 * Ucu de `{ rsid, genotype }` uretir; hizalamayi `panel.ts` yapar.
 *
 * # Neden hizalama sart
 *
 * Zincir yalnizca sirali dozajlar gorur. Iki kullanicinin "3 numarali SNP"si
 * ayni varyant DEGILSE kontenjans tablosu alakasiz seyleri toplar ve bu tek
 * kullaniciyla fark edilmez. Cikti bu yuzden PANEL sirasindadir, dosya
 * sirasinda degil.
 *
 * Dosya kullanicinin cihazindan cikmaz: ayristirma da sifreleme de burada,
 * tarayicida yapilir.
 */

type Source = "vcf" | "consumer";

interface Aligned {
  dosages: number[];
  covered: number;
  missing: number;
  ignored: number;
  sourceLabel: string;
  detail: string;
}

const WANTED_IDS = GENOMIC_PANEL.variants.map((v) => v.rsid);

export function GenomicStep({
  signer,
  trace,
  submitted,
  snpCount,
  disabled,
  onDone,
}: {
  signer: Signer | null;
  trace: TraceApi;
  submitted: number;
  snpCount: number;
  disabled: boolean;
  onDone: () => void;
}) {
  const vcf = useVcfParser();
  const fileInput = useRef<HTMLInputElement>(null);

  const [aligned, setAligned] = useState<Aligned | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = snpCount > 0 && submitted >= snpCount;

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setAligned(null);

      const name = file.name.toLowerCase();
      const source: Source =
        name.endsWith(".vcf") || name.endsWith(".vcf.gz") || name.endsWith(".bgz")
          ? "vcf"
          : "consumer";

      trace.begin("parse", "Dosya ayrıştırıldı (tarayıcıda)");
      try {
        let calls: GenotypeCall[] = [];
        /** VCF yolunda dozaj ayristiricidan hazir gelir: rsID -> dozaj. */
        let vcfDosageByRsid: Map<string, number> | null = null;
        let sourceLabel = "";
        let scanned = 0;

        if (source === "vcf") {
          // Panel filtresi Rust tarafinda uygulanir: tum genom VCF'i
          // milyonlarca satirdir, hepsini JS'e tasimak bellegi sisirirdi.
          const result = await vcf.parseAsync(file, undefined, WANTED_IDS);
          sourceLabel = `VCF · örnek ${result.sampleName}`;
          scanned = result.variantCount + result.filteredOutCount;

          // VCF'te dozaj REF/ALT'a gore hesaplanir ve ayristirici bunu zaten
          // yapmistir; tuketici dosyalarindaki gibi bir genotip metni yoktur.
          // Bu yuzden hizalama genotip uzerinden degil DOZAJ uzerinden yapilir.
          vcfDosageByRsid = new Map(
            result.ids.map((rsid, i) => [rsid.toLowerCase(), result.dosages[i]]),
          );
        } else {
          const text = await file.slice(0, 64 * 1024).text();
          const format = detectFormat(text);
          if (format === "unknown") {
            throw new Error(
              "Biçim tanınamadı. 23andMe / AncestryDNA ham veri dosyası ya da VCF bekleniyor.",
            );
          }
          const parsed = await parseConsumerFile(file);
          calls = parsed.calls;
          scanned = parsed.lines;
          sourceLabel =
            format === "23andme"
              ? `23andMe · ${parsed.lines.toLocaleString("tr")} satır`
              : `AncestryDNA · ${parsed.lines.toLocaleString("tr")} satır`;
        }

        trace.succeed("parse", `${sourceLabel} · ${scanned.toLocaleString("tr")} varyant tarandı`, [
          noteEvidence("kaynak", sourceLabel),
          valueEvidence("taranan varyant", scanned.toLocaleString("tr")),
          noteEvidence("dosya", `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`),
          noteEvidence("nerede işlendi", "tarayıcı — dosya cihazdan çıkmadı"),
        ]);

        // --- Panele hizalama ------------------------------------------------
        trace.begin("align", "Panele hizalandı");

        let result: Aligned;
        if (vcfDosageByRsid) {
          const byRsid = vcfDosageByRsid;
          const dosages = GENOMIC_PANEL.variants.map((v) => {
            const d = byRsid.get(v.rsid.toLowerCase());
            return d === undefined || d > 2 ? DOSAGE_MISSING : d;
          });
          const covered = dosages.filter((d) => d !== DOSAGE_MISSING).length;
          result = {
            dosages,
            covered,
            missing: dosages.length - covered,
            ignored: 0,
            sourceLabel,
            detail: `${covered}/${dosages.length} varyant kapsandı`,
          };
        } else {
          const a = alignToPanel(GENOMIC_PANEL, calls);
          result = {
            dosages: a.dosages,
            covered: a.covered,
            missing: a.missing,
            ignored: a.ignored,
            sourceLabel,
            detail: `${a.covered}/${a.dosages.length} varyant kapsandı`,
          };
        }

        setAligned(result);

        trace.succeed("align", result.detail, [
          valueEvidence("panel boyutu", GENOMIC_PANEL.variants.length),
          valueEvidence("kapsanan", result.covered),
          valueEvidence("eksik (3 olarak işaretlendi)", result.missing),
          ...(result.ignored > 0
            ? [valueEvidence("dosyada olup panelde olmayan", result.ignored)]
            : []),
          noteEvidence(
            "eksik neden 0 değil",
            "0 «homozigot referans» demektir; bilinmeyene 0 yazmak alel frekansını aşağı çeker",
          ),
        ]);
      } catch (err) {
        trace.fail(source === "vcf" ? "parse" : "parse", err);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [trace, vcf],
  );

  const submit = useCallback(async () => {
    if (!signer || !aligned) return;
    setBusy(true);
    setError(null);

    trace.begin("dosages", "Dozajlar şifrelenip gönderildi");
    try {
      let batches = 0;
      await contributeDosages(signer, aligned.dosages, {
        batchSize: 10,
        onBatch: (outcome, from, to) => {
          batches += 1;
          trace.push(
            "dosages",
            txEvidence(`parti ${batches} · SNP ${from}–${to - 1}`, outcome.hash),
            valueEvidence(`  blok`, outcome.blockNumber.toLocaleString("tr"), true),
            valueEvidence(`  gaz`, Number(outcome.gasUsed).toLocaleString("tr"), true),
            noteEvidence(`  ciphertext handle (ilk)`, outcome.handles[0]),
          );
          trace.progress("dosages", `${to}/${aligned.dosages.length} SNP gönderildi…`);
        },
      });

      trace.succeed(
        "dosages",
        `${aligned.dosages.length} SNP, ${batches} partide gönderildi`,
        [
          noteEvidence(
            "parti sınırı neden 10",
            "fhEVM işlem başına 20M HCU; ölçülen tavan 12 SNP (BiomarkerHcu/MultiSnpGas testleri)",
          ),
        ],
      );
      onDone();
    } catch (err) {
      trace.fail("dosages", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [signer, aligned, trace, onDone]);

  const progressPercent = useMemo(() => vcf.progress.percent, [vcf.progress.percent]);

  return (
    <div className="card">
      <div className="card__head">
        <h3>1 · Genomik veri</h3>
        <span className={complete ? "badge badge--ok" : "eyebrow"}>
          {complete ? `TAMAM · ${submitted}/${snpCount}` : `${submitted}/${snpCount} SNP`}
        </span>
      </div>

      <p className="card__body">
        VCF, 23andMe ya da AncestryDNA ham veri dosyası. Dosya cihazınızdan
        çıkmaz: ayrıştırma ve şifreleme tarayıcıda yapılır, zincire yalnızca
        şifreli dozajlar gider.
      </p>

      <input
        ref={fileInput}
        type="file"
        accept=".vcf,.vcf.gz,.bgz,.txt,.csv,.tsv"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />

      <div className="row" style={{ marginTop: 16 }}>
        <button
          className="pill pill--primary"
          onClick={() => fileInput.current?.click()}
          disabled={disabled || vcf.busy || busy || complete}
        >
          {vcf.busy ? "ayrıştırılıyor…" : "Dosya seç"}
        </button>

        {aligned && !complete && (
          <button className="pill pill--primary" onClick={() => void submit()} disabled={busy || disabled}>
            {busy ? "gönderiliyor…" : `Şifrele ve gönder (${aligned.dosages.length} SNP)`}
          </button>
        )}
      </div>

      {vcf.busy && progressPercent !== null && (
        <div className="progress" style={{ marginTop: 16 }}>
          <div className="progress__fill" style={{ width: `${progressPercent}%` }} />
        </div>
      )}

      {aligned && (
        <div className="kv" style={{ marginTop: 16 }}>
          <div className="kv__row">
            <span className="eyebrow">KAYNAK</span>
            <span className="mono">{aligned.sourceLabel}</span>
          </div>
          <div className="kv__row">
            <span className="eyebrow">KAPSAMA</span>
            <span className="mono">
              {aligned.covered}/{aligned.dosages.length}
              {aligned.missing > 0 && ` · ${aligned.missing} eksik`}
            </span>
          </div>
          <div className="kv__row">
            <span className="eyebrow">PANEL SIRASINDA DOZAJLAR</span>
            <span className="mono">
              {aligned.dosages
                .map((d) => (d === DOSAGE_MISSING ? "—" : d))
                .join(" ")}
            </span>
          </div>
        </div>
      )}

      {error && <div className="notice notice--warn">{error}</div>}
      {vcf.error && <div className="notice notice--warn">{vcf.error}</div>}
    </div>
  );
}
