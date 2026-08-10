import { useMemo, useState } from "react";

import {
  ANXIETY_ITEMS,
  ANXIETY_CHOICES,
  PANIC_ITEMS,
  PANIC_CHOICES,
  USAGE_GROUPS,
  USAGE_QUESTION,
  scoreAnxiety,
  scorePanic,
} from "@veriarfy/study";

export interface SurveyResult {
  group: number;
  anxiety: number;
  panic: number;
  anxietyBand: string;
}

interface SurveyProps {
  onComplete: (result: SurveyResult) => void;
  disabled?: boolean;
}

type Step = "usage" | "anxiety" | "panic" | "review";

export function Survey({ onComplete, disabled }: SurveyProps) {
  const [step, setStep] = useState<Step>("usage");
  const [group, setGroup] = useState<number | null>(null);
  const [anxiety, setAnxiety] = useState<(number | null)[]>(
    () => ANXIETY_ITEMS.map(() => null),
  );
  const [panic, setPanic] = useState<(number | null)[]>(
    () => PANIC_ITEMS.map(() => null),
  );

  const anxietyDone = anxiety.every((v) => v !== null);
  const panicDone = panic.every((v) => v !== null);

  const scores = useMemo(() => {
    if (!anxietyDone || !panicDone || group === null) return null;
    const a = scoreAnxiety(anxiety as number[]);
    const p = scorePanic(panic as number[]);
    return { anxiety: a, panic: p };
  }, [anxiety, panic, group, anxietyDone, panicDone]);

  const answeredAnx = anxiety.filter((v) => v !== null).length;
  const answeredPan = panic.filter((v) => v !== null).length;

  return (
    <div className="survey">
      <StepBar step={step} />

      {step === "usage" && (
        <section className="card card--bone">
          <span className="eyebrow eyebrow--12">ADIM 1 · MARUZIYET</span>
          <h3 style={{ marginTop: 12 }}>{USAGE_QUESTION}</h3>
          <p className="card__body" style={{ marginTop: 8 }}>
            Bu yanit da sifrelenir. Hangi grupta oldugunuz zincirde acik olarak
            yer almaz.
          </p>
          <div className="choice-grid" style={{ marginTop: 20 }}>
            {USAGE_GROUPS.map((g) => (
              <button
                key={g.id}
                className={`choice choice--wide ${group === g.id ? "choice--on" : ""}`}
                onClick={() => setGroup(g.id)}
              >
                <span className="bar-dot" style={{ background: g.color }} />
                <span>{g.label}</span>
                <span className="eyebrow">{g.short}</span>
              </button>
            ))}
          </div>
          <div className="survey__nav">
            <button
              className="pill pill--primary"
              disabled={group === null}
              onClick={() => setStep("anxiety")}
            >
              Devam →
            </button>
          </div>
        </section>
      )}

      {step === "anxiety" && (
        <section className="card card--bone">
          <div className="card__head">
            <span className="eyebrow eyebrow--12">ADIM 2 · ANKSIYETE (33 MADDE)</span>
            <span className="eyebrow">{answeredAnx}/33</span>
          </div>
          <p className="card__body">
            Son bir haftada asagidakiler sizi ne kadar rahatsiz etti?
          </p>

          <ItemList
            items={ANXIETY_ITEMS}
            choices={ANXIETY_CHOICES}
            values={anxiety}
            onChange={(i, v) =>
              setAnxiety((prev) => prev.map((old, idx) => (idx === i ? v : old)))
            }
          />

          <div className="survey__nav">
            <button className="pill pill--ghost" onClick={() => setStep("usage")}>
              ← Geri
            </button>
            <button
              className="pill pill--primary"
              disabled={!anxietyDone}
              onClick={() => setStep("panic")}
            >
              Devam →
            </button>
          </div>
        </section>
      )}

      {step === "panic" && (
        <section className="card card--bone">
          <div className="card__head">
            <span className="eyebrow eyebrow--12">ADIM 3 · PANIK (7 MADDE)</span>
            <span className="eyebrow">{answeredPan}/7</span>
          </div>
          <p className="card__body">Son bir haftayi dusunerek yanitlayin.</p>

          <ItemList
            items={PANIC_ITEMS}
            choices={PANIC_CHOICES}
            values={panic}
            onChange={(i, v) =>
              setPanic((prev) => prev.map((old, idx) => (idx === i ? v : old)))
            }
          />

          <div className="survey__nav">
            <button className="pill pill--ghost" onClick={() => setStep("anxiety")}>
              ← Geri
            </button>
            <button
              className="pill pill--primary"
              disabled={!panicDone}
              onClick={() => setStep("review")}
            >
              Ozete git →
            </button>
          </div>
        </section>
      )}

      {step === "review" && scores && (
        <section className="card card--bone">
          <span className="eyebrow eyebrow--12">ADIM 4 · GONDER</span>
          <h3 style={{ marginTop: 12 }}>Yanitlariniz sifrelenmeye hazir</h3>

          <div className="card__row" style={{ marginTop: 16 }}>
            <span className="eyebrow">KULLANIM GRUBU</span>
            <span className="mono" style={{ fontSize: 13 }}>
              {USAGE_GROUPS[group!].label}
            </span>
          </div>
          <div className="card__row">
            <span className="eyebrow">ANKSIYETE (0–99)</span>
            <span className="mono" style={{ fontSize: 13 }}>
              {scores.anxiety.total} · {scores.anxiety.band}
            </span>
          </div>
          <div className="card__row">
            <span className="eyebrow">PANIK (0–28)</span>
            <span className="mono" style={{ fontSize: 13 }}>
              {scores.panic.total}
            </span>
          </div>

          <div className="notice notice--info">
            Bu puanlar <strong>yalnizca sizin cihazinizda</strong> gorunur. Zincire
            yalnizca sifreli hali gider; arastirmaci dahil kimse bireysel puani
            cozemez.
          </div>

          <div className="survey__nav">
            <button className="pill pill--ghost" onClick={() => setStep("panic")}>
              ← Geri
            </button>
            <button
              className="pill pill--primary"
              disabled={disabled}
              onClick={() =>
                onComplete({
                  group: group!,
                  anxiety: scores.anxiety.total,
                  panic: scores.panic.total,
                  anxietyBand: scores.anxiety.band,
                })
              }
            >
              Sifrele ve gonder
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function ItemList({
  items,
  choices,
  values,
  onChange,
}: {
  items: { id: number; text: string }[];
  choices: { value: number; label: string }[];
  values: (number | null)[];
  onChange: (index: number, value: number) => void;
}) {
  return (
    <ol className="item-list">
      {items.map((item, i) => (
        <li className="item" key={item.id}>
          <div className="item__text">
            <span className="item__num mono">{String(item.id).padStart(2, "0")}</span>
            {item.text}
          </div>
          <div className="choice-grid">
            {choices.map((c) => (
              <button
                key={c.value}
                className={`choice ${values[i] === c.value ? "choice--on" : ""}`}
                onClick={() => onChange(i, c.value)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}

function StepBar({ step }: { step: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: "usage", label: "MARUZIYET" },
    { key: "anxiety", label: "ANKSIYETE" },
    { key: "panic", label: "PANIK" },
    { key: "review", label: "GONDER" },
  ];
  const activeIndex = steps.findIndex((s) => s.key === step);
  return (
    <div className="tabs" style={{ marginBottom: 24 }}>
      {steps.map((s, i) => (
        <span key={s.key} className={`tab ${i === activeIndex ? "active" : ""}`}>
          {s.label}
        </span>
      ))}
    </div>
  );
}
