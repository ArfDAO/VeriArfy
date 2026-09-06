import { useCallback, useMemo, useRef, useState } from "react";
import type { Signer } from "ethers";

import { alignToPanel, DOSAGE_MISSING, type GenotypeCall } from "../lib/panel";
import { detectFormat, parseConsumerFile } from "../lib/consumerGenotype";
import { GENOMIC_PANEL } from "../lib/studyPanel";
import { contributeDosages, submitProvenanceRecord } from "../lib/protocol";
import { useVcfParser } from "../lib/useVcfParser";
import type { TraceApi } from "../lib/useTrace";
import { noteEvidence, txEvidence, valueEvidence } from "../lib/trace";
import { useT } from "../lib/i18n";

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
  const t = useT();
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

      trace.begin("parse", t("Dosya ayrıştırıldı (tarayıcıda)"));
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
          sourceLabel = t("VCF · örnek {name}", { name: result.sampleName });
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
              ? t("23andMe · {lines} satır", { lines: parsed.lines.toLocaleString() })
              : t("AncestryDNA · {lines} satır", { lines: parsed.lines.toLocaleString() });
        }

        trace.succeed("parse", t("{source} · {n} varyant tarandı", { source: sourceLabel, n: scanned.toLocaleString() }), [
          noteEvidence("kaynak", sourceLabel),
          valueEvidence(t("taranan varyant"), scanned.toLocaleString("tr")),
          noteEvidence("dosya", `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`),
          noteEvidence(t("nerede işlendi"), t("tarayıcı — dosya cihazdan çıkmadı")),
        ]);

        // --- Panele hizalama ------------------------------------------------
        trace.begin("align", t("Panele hizalandı"));

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
            detail: t("{covered}/{total} varyant kapsandı", { covered, total: dosages.length }),
          };
        } else {
          const a = alignToPanel(GENOMIC_PANEL, calls);
          result = {
            dosages: a.dosages,
            covered: a.covered,
            missing: a.missing,
            ignored: a.ignored,
            sourceLabel,
            detail: t("{covered}/{total} varyant kapsandı", { covered: a.covered, total: a.dosages.length }),
          };
        }

        setAligned(result);

        trace.succeed("align", result.detail, [
          valueEvidence(t("panel boyutu"), GENOMIC_PANEL.variants.length),
          valueEvidence(t("kapsanan"), result.covered),
          valueEvidence(t("eksik (3 olarak işaretlendi)"), result.missing),
          ...(result.ignored > 0
            ? [valueEvidence(t("dosyada olup panelde olmayan"), result.ignored.toLocaleString("tr"))]
            : []),
          noteEvidence(t("eksik neden 0 değil"), t("0 «homozigot referans» demektir; bilinmeyene 0 yazmak alel frekansını aşağı çeker"),
          ),
          noteEvidence(t("kapsama nasıl belirlendi"), t("size sorulmadı — dosyanız ayrıştırıldı. Hangi alanlarda gerçek veriniz olduğu ödemeyi belirler: araştırmacı o alanları isterse pay alırsınız"),
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

    trace.begin("dosages", t("Dozajlar şifrelenip gönderildi"));
    try {
      let batches = 0;
      await contributeDosages(signer, aligned.dosages, {
        batchSize: 10,

        // KANIT, DOZAJLARDAN ÖNCE.
        //
        // Kanıt, havuza girecek şifreli metinlerin özetine bağlanır; bu
        // yüzden şifreleme bittikten sonra ama ilk işlem gitmeden önce
        // üretilir. Sıra tersine dönseydi sözleşme beyan edilen kapsamayı
        // kanıtsız yazardı ve ödeme yine uydurulabilir olurdu.
        onEncrypted: async (handles) => {
          trace.begin("provenance", t("ZK köken kanıtı üretildi ve gönderildi"));
          try {
            const record = await submitProvenanceRecord(
              signer,
              aligned.dosages,
              handles,
              {
                onStage: (stage) => {
                  const label = {
                    digest: "şifreli metinlerin özeti alınıyor…",
                    proving: "tarayıcıda Groth16 kanıtı üretiliyor…",
                    sending: "kanıt zincire gönderiliyor…",
                  }[stage];
                  trace.progress("provenance", t(label));
                },
              },
            );

            if (!record) {
              trace.succeed("provenance", t("Köken kaydı zaten var — atlandı"), [
                noteEvidence(t("neden atlandı"), t("nullifier bir kez harcanır; mevcut kayıt zaten kapsamayı kanıtla yazmış durumda"),
                ),
              ]);
              return;
            }

            trace.succeed(
              "provenance",
              t("{n} alan KANITLA yazıldı ({ms} ms)", { n: record.coveredFields, ms: Math.round(record.provingMs) }),
              [
                txEvidence(t("submitRecord"), record.outcome.hash),
                valueEvidence(t("  blok"), record.outcome.blockNumber.toLocaleString("tr"), true),
                valueEvidence(t("  gaz"), Number(record.outcome.gasUsed).toLocaleString("tr"), true),
                noteEvidence("  kanıtın bağlandığı özet", record.digest),
                noteEvidence(t("kanıt ne söylüyor"), t("kapsama bitleri TAM OLARAK taahhüde giren dozajlardan türedi — «bende bu alan var» deyip boş göndermek imkânsız"),
                ),
                noteEvidence(t("kanıt ne söylemiyor"), t("verinin gerçek bir ölçümden geldiğini söylemez; onu ancak imzalayan akredite bir kurum söyleyebilir, ZK söyleyemez"),
                ),
                noteEvidence(t("paneliniz zincire girdi mi"), t("hayır — yalnızca taahhüt (Poseidon özeti) yazıldı; dozajlar kanıtın içinde gizli kalır"),
                ),
              ],
            );
          } catch (err) {
            trace.fail("provenance", err);
            throw err;
          }
        },

        onBatch: (outcome, from, to) => {
          batches += 1;
          trace.push(
            "dosages",
            txEvidence(`parti ${batches} · SNP ${from}–${to - 1}`, outcome.hash),
            valueEvidence(`  blok`, outcome.blockNumber.toLocaleString("tr"), true),
            valueEvidence(`  gaz`, Number(outcome.gasUsed).toLocaleString("tr"), true),
            noteEvidence(t("  ciphertext handle (ilk)"), outcome.handles[0]),
          );
          trace.progress("dosages", t("{done}/{total} SNP gönderildi…", { done: to, total: aligned.dosages.length }));
        },
      });

      trace.succeed(
        "dosages",
        t("{n} SNP, {batches} partide gönderildi", { n: aligned.dosages.length, batches }),
        [
          noteEvidence(t("parti sınırı neden 10"), t("fhEVM işlem başına 20M HCU; ölçülen tavan 12 SNP (BiomarkerHcu/MultiSnpGas testleri)"),
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
        <h3>{t("2 · Genomik veri")}</h3>
        <span className={complete ? "badge badge--ok" : "eyebrow"}>
          {complete ? `TAMAM · ${submitted}/${snpCount}` : `${submitted}/${snpCount} SNP`}
        </span>
      </div>

      <p className="card__body">
        VCF, 23andMe ya da AncestryDNA ham veri dosyası. Dosya cihazınızdan
        çıkmaz: ayrıştırma ve şifreleme tarayıcıda yapılır, zincire yalnızca
        şifreli dozajlar gider.
      </p>
      <p className="card__body">
        <strong>{t("Dosyanızın içinde ne olduğunu bilmenize gerek yok.")}</strong>{" "}
        Türünü seçmeniz yeter — hangi varyantların bulunduğunu sistem
        ayrıştırıp çıkarır. Bu, ödemeyi de belirler: bir araştırmacı sizde
        <em>{t("olan")}</em> {t("alanları isterse pay alırsınız.")}
      </p>

      {submitted > 0 && !complete && (
        <div className="notice notice--info" style={{ marginTop: 16 }}>
          Kaldığınız yerden devam edin: zincirde {submitted}/{snpCount} SNP kaydı var. Aynı panel
          sırasıyla kalan veriyi gönderin; sözleşme sırayı doğrular.
        </div>
      )}

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
            {busy ? t("gönderiliyor…") : t("Şifrele ve gönder ({n} SNP)", { n: aligned.dosages.length })}
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
            <span className="eyebrow">{t("KAYNAK")}</span>
            <span className="mono">{aligned.sourceLabel}</span>
          </div>
          <div className="kv__row">
            <span className="eyebrow">{t("KAPSAMA")}</span>
            <span className="mono">
              {aligned.covered}/{aligned.dosages.length}
              {aligned.missing > 0 && ` · ${aligned.missing} eksik`}
            </span>
          </div>
          <div className="kv__row">
            <span className="eyebrow">{t("ÖDEMEYE ESAS ALAN")}</span>
            <span className="mono">{aligned.covered} alan</span>
          </div>
          <div className="kv__row">
            <span className="eyebrow">{t("PANEL SIRASINDA DOZAJLAR")}</span>
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
