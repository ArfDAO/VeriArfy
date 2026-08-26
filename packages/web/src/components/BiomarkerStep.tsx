import { useCallback, useEffect, useMemo, useState } from "react";
import { Contract, type Signer } from "ethers";

import { BIOMARKERS_ABI } from "../config/abi";
import { BIOMARKER_MISSING, encodeValue, type MetricSpec } from "../lib/metrics";
import { contributeBiomarkers } from "../lib/protocol";
import type { TraceApi } from "../lib/useTrace";
import { noteEvidence, txEvidence, valueEvidence } from "../lib/trace";

/**
 * Veri kategorisi 2 — surekli biyobelirtec ve fizyolojik telemetri.
 *
 * # Metrik tanimi ZINCIRDEN okunur
 *
 * Olcek, birim ve gecerli aralik yerel bir dosyadan degil sozlesmeden gelir.
 * Sebep: eleme zincirde yapiliyor. Yerel bir kopya kullanilsaydi ilan edilen
 * sinir ile ZORLANAN sinir sessizce ayrisabilirdi.
 *
 * # Bos birakmak serbesttir
 *
 * Olculmemis metrik `BIOMARKER_MISSING` (0) olarak gider ve o metrigin
 * sayimina HIC girmez — ortalamayi asagi cekmez. Aralik disi bir deger de
 * kirpilmaz, elenir: 200 ml/kg/dk 90'a kirpilsaydi "olaganustu sporcu" olarak
 * uydurma bir gozlem eklenirdi.
 */

interface Row extends MetricSpec {
  index: number;
  input: string;
}

/** `bytes32` icine sifir dolgulu ASCII etiketi geri okur. */
function decodeBytes32(value: string): string {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  let out = "";
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

const real = (encoded: number, spec: MetricSpec) => (encoded - spec.offset) / spec.scale;

export function BiomarkerStep({
  signer,
  moduleAddress,
  trace,
  submitted,
  metricCount,
  disabled,
  onDone,
}: {
  signer: Signer | null;
  moduleAddress: string;
  trace: TraceApi;
  submitted: number;
  metricCount: number;
  disabled: boolean;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = metricCount > 0 && submitted >= metricCount;

  useEffect(() => {
    if (!signer || !moduleAddress) return;
    let cancelled = false;

    (async () => {
      try {
        const biomarkers = new Contract(moduleAddress, BIOMARKERS_ABI, signer);
        const count = Number(await biomarkers.metricCount());

        const loaded: Row[] = [];
        for (let i = 0; i < count; i++) {
          const spec = await biomarkers.metricAt(i);
          loaded.push({
            index: i,
            code: decodeBytes32(spec.code),
            unit: decodeBytes32(spec.unit),
            scale: Number(spec.scale),
            offset: Number(spec.offset),
            minValue: Number(spec.minValue),
            maxValue: Number(spec.maxValue),
            input: "",
          });
        }
        if (!cancelled) setRows(loaded);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [signer, moduleAddress]);

  /** Girilen degerleri zincirin bekledigi tamsayilara cevirir. */
  const encoded = useMemo(() => {
    if (!rows) return null;
    return rows.map((row) => {
      if (row.input.trim() === "") return { value: BIOMARKER_MISSING, state: "bos" as const };
      const parsed = Number(row.input.replace(",", "."));
      const code = encodeValue(parsed, row);
      return code === null
        ? { value: BIOMARKER_MISSING, state: "aralikDisi" as const }
        : { value: code, state: "gecerli" as const };
    });
  }, [rows]);

  const filled = encoded?.filter((e) => e.state === "gecerli").length ?? 0;
  const outOfRange = encoded?.filter((e) => e.state === "aralikDisi").length ?? 0;

  const submit = useCallback(async () => {
    if (!signer || !rows || !encoded) return;
    setBusy(true);
    setError(null);

    trace.begin("biomarkers", "Ölçümler şifrelenip gönderildi");
    try {
      const values = encoded.map((e) => e.value);
      let batches = 0;

      await contributeBiomarkers(signer, values, {
        batchSize: 6,
        onBatch: (outcome, from, to) => {
          batches += 1;
          trace.push(
            "biomarkers",
            txEvidence(`parti ${batches} · metrik ${from}–${to - 1}`, outcome.hash),
            valueEvidence("  blok", outcome.blockNumber.toLocaleString("tr"), true),
            valueEvidence("  gaz", Number(outcome.gasUsed).toLocaleString("tr"), true),
            noteEvidence("  ciphertext handle (ilk)", outcome.handles[0]),
          );
          trace.progress("biomarkers", `${to}/${values.length} metrik gönderildi…`);
        },
      });

      trace.succeed(
        "biomarkers",
        `${values.length} metrik, ${batches} partide gönderildi (${filled} ölçüm, ${values.length - filled} eksik)`,
        [
          noteEvidence(
            "parti sınırı neden 6",
            "kareler toplamı için mul(euint64,euint64) = 596.000 HCU; ölçülen tavan 8 metrik",
          ),
          noteEvidence(
            "eksik ölçüm ne oluyor",
            "0 aralık dışı olduğu için o metriğin n sayımına hiç girmiyor — ortalamayı bozmuyor",
          ),
          valueEvidence("ödemeye esas alan", filled, true),
          noteEvidence(
            "kapsama nasıl belirlendi",
            "doldurduğunuz alanlardan türetildi; boş bıraktığınız metrik ödemeye de girmez",
          ),
        ],
      );
      onDone();
    } catch (err) {
      trace.fail("biomarkers", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [signer, rows, encoded, trace, filled, onDone]);

  return (
    <div className="card">
      <div className="card__head">
        <h3>3 · Biyobelirteç ve telemetri</h3>
        <span className={complete ? "badge badge--ok" : "eyebrow"}>
          {complete ? `TAMAM · ${submitted}/${metricCount}` : `${submitted}/${metricCount} METRİK`}
        </span>
      </div>

      <p className="card__body">
        Ölçek, birim ve geçerli aralık sözleşmeden okundu — eleme zincirde
        yapılıyor. Ölçmediğiniz metriği boş bırakın: o metriğin sayımına hiç
        girmez, ortalamayı aşağı çekmez.
      </p>
      <p className="card__body">
        Değeri <strong>kendi biriminde</strong> yazın (örneğin VO2 max için{" "}
        <span className="mono">52,3</span>). Sağdaki sayı, ölçekle çarpılıp
        sıfır noktası eklendikten sonra <strong>zincire giden tamsayıdır</strong> —
        şifrelenen budur. Sözleşme yalnızca tamsayıyla çalışır çünkü homomorfik
        aritmetikte ondalık yoktur.
      </p>

      {!rows && !error && <p className="card__body">Metrik paneli okunuyor…</p>}

      {rows && (
        <div className="metrics">
          {rows.map((row, i) => {
            const state = encoded?.[i].state;
            return (
              <div className="metric" key={row.code}>
                <div className="metric__label">
                  <span className="mono metric__code">{row.code}</span>
                  <span className="eyebrow">
                    {real(row.minValue, row).toLocaleString("tr")} –{" "}
                    {real(row.maxValue, row).toLocaleString("tr")} {row.unit}
                  </span>
                </div>
                <div className="metric__input">
                  <input
                    inputMode="decimal"
                    placeholder="ölçülmedi"
                    value={row.input}
                    disabled={disabled || busy || complete}
                    className={state === "aralikDisi" ? "input--bad" : undefined}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev
                          ? prev.map((r, j) => (j === i ? { ...r, input: e.target.value } : r))
                          : prev,
                      )
                    }
                  />
                  <span
                    className={
                      state === "gecerli"
                        ? "metric__state metric__state--ok"
                        : state === "aralikDisi"
                          ? "metric__state metric__state--bad"
                          : "metric__state"
                    }
                  >
                    {state === "gecerli"
                      ? `zincire → ${encoded?.[i].value.toLocaleString("tr")}`
                      : state === "aralikDisi"
                        ? "aralık dışı → elenir"
                        : "eksik"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {outOfRange > 0 && (
        <div className="notice notice--warn">
          {outOfRange} ölçüm panelin aralığı dışında. Kırpılmıyor — o metriğin
          sayımına hiç girmeyecek. Uydurma bir gözlem eklemektense elemek doğru
          davranış, ama değeri kontrol etmek isteyebilirsiniz.
        </div>
      )}

      {rows && !complete && (
        <div className="row" style={{ marginTop: 16 }}>
          <button
            className="pill pill--primary"
            onClick={() => void submit()}
            disabled={disabled || busy || filled === 0}
          >
            {busy ? "gönderiliyor…" : `Şifrele ve gönder (${filled} ölçüm)`}
          </button>
          {filled === 0 && (
            <span className="eyebrow">EN AZ BİR ÖLÇÜM GEREKLİ</span>
          )}
        </div>
      )}

      {error && <div className="notice notice--warn">{error}</div>}
    </div>
  );
}
