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
export interface ChiSquareResult {
  chi2: number; df: number; p: number; total: number; minExpected: number; reliable: boolean;
}
export function chiSquareP(chi2: number, df: number): number;
export function chiSquareTest(table: number[][]): ChiSquareResult;
export function benjaminiHochberg(pValues: number[]): number[];
export interface GenotypeFrequencies {
  n: number;
  genotype: number[];
  allele: { reference: number; alternate: number };
  maf: number;
}
export function genotypeFrequencies(counts: [number, number, number]): GenotypeFrequencies;
export function hardyWeinbergTest(counts: [number, number, number]): GenotypeFrequencies & {
  expected: number[]; chi2: number; df: number; p: number; minExpected: number; reliable: boolean;
};
export function allelicOddsRatio(table: [[number, number, number], [number, number, number]]): {
  oddsRatio: number; ci95: [number, number]; standardError: number; note: string | null;
};
export function fisherFreemanHaltonTest(table: number[][]): { p: number; observedProbability: number; tables: number };
export function summarizeGenomicTable(table: [[number, number, number], [number, number, number]]): {
  groups: { frequencies: GenotypeFrequencies; hwe: ReturnType<typeof hardyWeinbergTest> }[];
  association: { chiSquare: ChiSquareResult; fisher: ReturnType<typeof fisherFreemanHaltonTest> | null; oddsRatio: ReturnType<typeof allelicOddsRatio> };
};

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

// --- E/18 sentetik BMI + SNP parity fixture'i ---
export const E18_SYNTHETIC_FIXTURE_ID: string;
export const E18_SYNTHETIC_GROUP_SIZE: number;
export const E18_SYNTHETIC_PARTICIPANTS: number;
export interface E18SyntheticRow {
  group: 0 | 1;
  dosage: 0 | 1 | 2;
  bmi: number;
}
export interface E18PlaintextReference {
  participantCount: number;
  contingency: number[][];
  bmi: Aggregate[];
}
export function makeE18SyntheticCohort(): E18SyntheticRow[];
export function e18PlaintextReference(rows: E18SyntheticRow[]): E18PlaintextReference;
