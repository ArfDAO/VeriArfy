export interface Choice {
  value: number;
  label: string;
}

export interface Item {
  id: number;
  text: string;
  sub?: string;
}

export interface UsageGroup {
  id: number;
  label: string;
  short: string;
  color: string;
}

export interface Aggregate {
  n: number;
  sum: number;
  sumSq: number;
}

export interface GroupSummary {
  n: number;
  mean: number;
  variance: number;
  sd: number;
  sum: number;
  sumSq: number;
}

export interface Comparison {
  a: GroupSummary;
  b: GroupSummary;
  meanDiff: number;
  t: number;
  df: number;
  p: number;
  cohensD: number;
  ci95: [number, number];
  significant: boolean;
  note: string | null;
}

export interface Aggregates {
  anxiety: Aggregate[];
  panic: Aggregate[];
}

export interface StudyResult {
  anxiety: Comparison;
  panic: Comparison;
  groups: Aggregates;
}

// --- Olcekler ---
export const ANXIETY_CHOICES: Choice[];
export const ANXIETY_ITEMS: Item[];
export const ANXIETY_MAX: number;
export const ANXIETY_BANDS: { min: number; max: number; label: string }[];
export function anxietyBand(score: number): string;

export const PANIC_CHOICES: Choice[];
export const PANIC_ITEMS: Item[];
export const PANIC_MAX: number;

export const SUBSCALES: Record<string, string>;
export const USAGE_GROUPS: UsageGroup[];
export const USAGE_QUESTION: string;
export const GROUP_COUNT: number;
export const PRIMARY_CONTRAST: { a: number; b: number };

// --- Puanlama ---
export function scoreAnxiety(responses: number[]): {
  total: number;
  max: number;
  band: string;
  subtotals: Record<string, number>;
};
export function scorePanic(responses: number[]): { total: number; max: number };
export function scoreSubmission(input: {
  group: number;
  anxietyResponses: number[];
  panicResponses: number[];
}): { group: number; anxiety: number; panic: number; detail: any };

// --- Istatistik ---
export function describe(agg: Aggregate): GroupSummary;
export function compareGroups(a: Aggregate, b: Aggregate): Comparison;
export function effectSizeLabel(d: number): string;
export function formatP(p: number): string;
export function twoTailedP(t: number, df: number): number;
export function studentTCdf(t: number, df: number): number;
export function studentTQuantile(p: number, df: number): number;
export function betai(a: number, b: number, x: number): number;
export function gammaln(x: number): number;

// --- Hatlar ---
export function aggregate(
  rows: { group: number; anxiety: number; panic: number }[],
): Aggregates;
export function analyze(aggregates: Aggregates): StudyResult;
export function runPlaintextPipeline(
  rows: { group: number; anxiety: number; panic: number }[],
): { aggregates: Aggregates; result: StudyResult };

// --- Test verisi ---
export function rng(seed: number): () => number;
export function makeCohort(opts?: {
  seed?: number;
  groupSizes?: number[];
  severity?: number[];
}): { group: number; anxietyResponses: number[]; panicResponses: number[] }[];
