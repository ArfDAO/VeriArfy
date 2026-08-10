import { useCallback, useEffect, useState } from "react";
import type { BrowserProvider } from "ethers";

import {
  USAGE_GROUPS,
  PRIMARY_CONTRAST,
  analyze,
  effectSizeLabel,
  formatP,
} from "@veriarfy/study";

import { readAggregateHandles } from "../lib/contracts";
import { publicDecrypt, isZeroHandle } from "../lib/fhe";
import { isDeployed } from "../config";

type Agg = { n: number; sum: number; sumSq: number };
type Aggregates = { anxiety: Agg[]; panic: Agg[] };

interface ResultsProps {
  provider: BrowserProvider | null;
  refreshKey: number;
}

export function Results({ provider, refreshKey }: ResultsProps) {
  const [aggregates, setAggregates] = useState<Aggregates | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!provider || !isDeployed) return;
    setLoading(true);
    setError(null);
    try {
      const handles = await readAggregateHandles(provider);

      // Tum handle'lari topla ve tek seferde herkese acik coz.
      const all: string[] = [];
      for (const kind of ["anxiety", "panic"] as const) {
        for (const row of handles[kind]) {
          for (const h of [row.n, row.sum, row.sumSq]) {
            if (!isZeroHandle(h)) all.push(h);
          }
        }
      }

      const clear = all.length ? await publicDecrypt(all) : {};
      const value = (h: string) =>
        isZeroHandle(h) ? 0 : Number(clear[h.toLowerCase()] ?? 0);

      const shape = (kind: "anxiety" | "panic"): Agg[] =>
        handles[kind].map((row) => ({
          n: value(row.n),
          sum: value(row.sum),
          sumSq: value(row.sumSq),
        }));

      setAggregates({ anxiety: shape("anxiety"), panic: shape("panic") });
    } catch (err: any) {
      setError(err?.message ?? "Sonuclar okunamadi.");
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  if (!isDeployed) {
    return (
      <div className="card">
        <span className="eyebrow eyebrow--12">SONUCLAR</span>
        <p className="card__body" style={{ marginTop: 12 }}>
          Kontratlar heniz deploy edilmedi. <code>npm run deploy:sepolia</code>{" "}
          calistirdiktan sonra canli sonuclar burada gorunur.
        </p>
      </div>
    );
  }

  const result = aggregates ? analyze(aggregates) : null;
  const lo = USAGE_GROUPS[PRIMARY_CONTRAST.a];
  const hi = USAGE_GROUPS[PRIMARY_CONTRAST.b];

  return (
    <div className="chart-grid">
      <section className="card">
        <div className="card__head">
          <span className="eyebrow eyebrow--12">
            BIRINCIL KARSILASTIRMA · {lo.label} vs {hi.label}
          </span>
          <button className="pill pill--ghost" style={{ padding: "6px 12px" }} onClick={load}>
            {loading ? "Cozuluyor…" : "Yenile"}
          </button>
        </div>

        {error && <div className="notice notice--warn">{error}</div>}

        {!result && !error && (
          <p className="card__body">Sifreli toplamlar cozuluyor…</p>
        )}

        {result && (
          <>
            <MeasureBlock
              title="Anksiyete — Burns (0–99)"
              cmp={result.anxiety}
              groups={aggregates!.anxiety}
              max={99}
            />
            <div style={{ height: 32 }} />
            <MeasureBlock
              title="Panik — PDSS yapisi (0–28)"
              cmp={result.panic}
              groups={aggregates!.panic}
              max={28}
            />
          </>
        )}
      </section>

      <aside className="card">
        <span className="eyebrow eyebrow--12">NE ACILDI</span>
        <h3 style={{ marginTop: 12, fontSize: 20, fontWeight: 500 }}>
          Yalnizca grup toplamlari
        </h3>
        <p className="card__body" style={{ marginTop: 8 }}>
          Zincirden okunan tek sey her grup icin uc sayidir:{" "}
          <span className="mono">n</span>, <span className="mono">Σx</span> ve{" "}
          <span className="mono">Σx²</span>. Ortalama ve varyans bunlardan
          turetilir — bireysel hicbir puan cozulmez.
        </p>

        {aggregates && (
          <div style={{ marginTop: 16 }}>
            <span className="eyebrow">COZULEN TOPLAMLAR — ANKSIYETE</span>
            {aggregates.anxiety.map((a, g) => (
              <div className="card__row" key={g}>
                <span style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="bar-dot" style={{ background: USAGE_GROUPS[g].color }} />
                  {USAGE_GROUPS[g].label}
                </span>
                <span className="mono" style={{ fontSize: 11 }}>
                  n={a.n} Σx={a.sum} Σx²={a.sumSq}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="notice notice--info" style={{ marginTop: 20 }}>
          Bu sayilar herkese acik olarak cozulebilir — sonuc dogrulanabilir
          olsun diye. Bireysel yanitlar icin boyle bir izin hicbir zaman verilmez.
        </div>
      </aside>
    </div>
  );
}

function MeasureBlock({
  title,
  cmp,
  groups,
  max,
}: {
  title: string;
  cmp: any;
  groups: Agg[];
  max: number;
}) {
  const means = groups.map((g) => (g.n > 0 ? g.sum / g.n : 0));
  const scaleMax = Math.max(...means, 1);

  return (
    <div>
      <h3 style={{ fontSize: 18, fontWeight: 500, marginBottom: 16 }}>{title}</h3>

      {USAGE_GROUPS.map((g, i) => {
        const mean = means[i];
        const pct = Math.max((mean / scaleMax) * 100, 4);
        return (
          <div className="bar-row" key={g.id}>
            <div className="bar-row__name">
              <span className="bar-dot" style={{ background: g.color }} />
              {g.label}
            </div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${pct}%` }}>
                {groups[i].n > 0 ? mean.toFixed(1) : "—"}
              </div>
            </div>
          </div>
        );
      })}

      <div className="stat-strip">
        <Stat label="FARK" value={fmt(cmp.meanDiff)} />
        <Stat label="p" value={formatP(cmp.p)} />
        <Stat label="COHEN'S D" value={fmt(cmp.cohensD)} />
        <Stat
          label="ETKI"
          value={Number.isNaN(cmp.cohensD) ? "—" : effectSizeLabel(cmp.cohensD)}
        />
      </div>

      {cmp.note && <div className="notice notice--warn">{cmp.note}</div>}
      {!cmp.note && (
        <div className={`notice ${cmp.significant ? "notice--ok" : "notice--info"}`}>
          {cmp.significant
            ? `Fark istatistiksel olarak anlamli (p ${formatP(cmp.p)}). %95 GA: [${fmt(
                cmp.ci95[0],
              )}, ${fmt(cmp.ci95[1])}]`
            : "Bu ornek buyuklugunde fark istatistiksel olarak anlamli degil."}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div className="mono" style={{ fontSize: 18, marginTop: 4 }}>
        {value}
      </div>
    </div>
  );
}

function fmt(x: number) {
  return Number.isFinite(x) ? x.toFixed(2) : "—";
}
