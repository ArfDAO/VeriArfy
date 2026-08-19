import { useCallback, useRef, useState } from "react";

import type { Evidence, TraceStep } from "./trace";

/**
 * Dogrulama izini biriktiren kucuk depo.
 *
 * @remarks Adimlar SIRAYLA eklenir ve silinmez; bir hata olsa bile ekranda
 *          kalir. Hatayi gizlemek, konsolun tum amacini bosa cikarirdi.
 */
export interface TraceApi {
  steps: TraceStep[];
  /** Yeni adim baslatir (ya da varsa yeniden calistirir). */
  begin(id: string, label: string): void;
  /** Adimi basariyla kapatir. */
  succeed(id: string, detail: string, evidence?: Evidence[]): void;
  /** Adimi hatayla kapatir; hata metni ekranda kalir. */
  fail(id: string, error: unknown): void;
  /** Acik bir adima kanit ekler (ornegin her parti icin bir islem ozeti). */
  push(id: string, ...evidence: Evidence[]): void;
  /** Adimin aciklamasini gunceller — uzun islemlerde ilerleme gostergesi. */
  progress(id: string, detail: string): void;
  reset(): void;
}

export function useTrace(): TraceApi {
  const [steps, setSteps] = useState<TraceStep[]>([]);
  // Zaman damgalari React durumundan BAGIMSIZ tutulur: ardisik iki
  // `setSteps` arasinda okunan bir `Date.now()` yanlis sure verirdi.
  const clock = useRef(new Map<string, number>());

  const update = useCallback(
    (id: string, patch: (step: TraceStep) => TraceStep) => {
      setSteps((prev) => prev.map((s) => (s.id === id ? patch(s) : s)));
    },
    [],
  );

  const begin = useCallback((id: string, label: string) => {
    clock.current.set(id, Date.now());
    setSteps((prev) => {
      const existing = prev.find((s) => s.id === id);
      const fresh: TraceStep = {
        id,
        label,
        status: "running",
        evidence: [],
        startedAt: Date.now(),
      };
      return existing ? prev.map((s) => (s.id === id ? fresh : s)) : [...prev, fresh];
    });
  }, []);

  const succeed = useCallback(
    (id: string, detail: string, evidence: Evidence[] = []) => {
      update(id, (s) => ({
        ...s,
        status: "ok",
        detail,
        evidence: [...s.evidence, ...evidence],
        endedAt: Date.now(),
      }));
    },
    [update],
  );

  const fail = useCallback(
    (id: string, error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : JSON.stringify(error);

      update(id, (s) => ({
        ...s,
        status: "fail",
        detail: message,
        endedAt: Date.now(),
      }));
    },
    [update],
  );

  const push = useCallback(
    (id: string, ...evidence: Evidence[]) => {
      update(id, (s) => ({ ...s, evidence: [...s.evidence, ...evidence] }));
    },
    [update],
  );

  const progress = useCallback(
    (id: string, detail: string) => update(id, (s) => ({ ...s, detail })),
    [update],
  );

  const reset = useCallback(() => {
    clock.current.clear();
    setSteps([]);
  }, []);

  return { steps, begin, succeed, fail, push, progress, reset };
}
