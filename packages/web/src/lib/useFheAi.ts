/**
 * VeriArfy — `useFheAi`
 *
 * Sifreli AI cikarim hattini React'e baglar.
 *
 * ```tsx
 * const vcf = useVcfParser();
 * const ai  = useFheAi();
 *
 * // Panel onizlemesi anahtarsiz calisir:
 * const preview = await ai.preview(vcf.result.dosages);
 *
 * // Sifreli analiz icin modele ozel bir sifreleyici gerekir:
 * const result = await ai.analyze(vcf.result.dosages, encryptor);
 * ```
 *
 * **Sifreleyici bu pakette gelmez.** `concrete-ml`'in tarayici istemcisi
 * yayinlanmadigi icin `analyze` ancak disaridan bir `ModelEncryptor`
 * takildiginda calisir; takilmazsa acikca hata verir. `preview`, `panel` ve
 * `health` ise bugun calisir ve kriptodan bagimsizdir.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  alignToPanel,
  analyzeEncrypted,
  fetchHealth,
  fetchPanel,
  FheAiError,
  type AnalysisResult,
  type AnalysisStage,
  type ModelEncryptor,
  type PanelSpec,
} from "./fheAiClient";

export type { AnalysisResult, AnalysisStage, ModelEncryptor, PanelSpec };
export { FheAiError };

export interface FheAiHealth {
  ready: boolean;
  error: string | null;
  panelSize: number | null;
  label: string | null;
  report: Record<string, unknown> | null;
}

export function useFheAi(options: { autoLoad?: boolean } = {}) {
  const { autoLoad = true } = options;

  const [panel, setPanel] = useState<PanelSpec | null>(null);
  const [health, setHealth] = useState<FheAiHealth | null>(null);
  const [stage, setStage] = useState<AnalysisStage | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Sunucunun durumunu ve guncel panelini ceker. */
  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [raw, panelSpec] = await Promise.all([fetchHealth(), fetchPanel()]);
      if (!alive.current) return;

      setHealth({
        ready: Boolean(raw.ready),
        error: (raw.error as string | null) ?? null,
        panelSize: (raw.panel_size as number | null) ?? null,
        label: (raw.label as string | null) ?? null,
        report: (raw.report as Record<string, unknown> | null) ?? null,
      });
      setPanel(panelSpec);
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (autoLoad) void refresh();
  }, [autoLoad, refresh]);

  /**
   * Paneli sifrelemeden uygular — hangi varyantlar analize girecek,
   * dozajlari ne? Anahtar gerektirmez, aninda doner.
   */
  const preview = useCallback(
    (dosages: Uint8Array, spec?: PanelSpec) => {
      const active = spec ?? panel;
      if (!active) {
        throw new FheAiError("panel henuz yuklenmedi — once refresh() cagirin");
      }
      return alignToPanel(dosages, active);
    },
    [panel],
  );

  /** Tam sifreli analiz. `encryptor` zorunludur. */
  const analyze = useCallback(
    async (dosages: Uint8Array, encryptor: ModelEncryptor) => {
      setBusy(true);
      setError(null);
      setResult(null);
      try {
        const value = await analyzeEncrypted(dosages, {
          encryptor,
          panel: panel ?? undefined,
          onStage: (s) => alive.current && setStage(s),
        });
        if (alive.current) setResult(value);
        return value;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (alive.current) setError(message);
        throw e;
      } finally {
        if (alive.current) {
          setBusy(false);
          setStage(null);
        }
      }
    },
    [panel],
  );

  // Memoize: tuketici bunu bir useEffect bagimliligina koyabilsin.
  return useMemo(
    () => ({ panel, health, stage, result, error, busy, refresh, preview, analyze }),
    [panel, health, stage, result, error, busy, refresh, preview, analyze],
  );
}
