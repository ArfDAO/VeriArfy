import { existsSync, readFileSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import { keccak256, toUtf8Bytes } from "ethers";

export type OnchainMetricSpec = {
  code: string;
  unit: string;
  scale: number;
  offset: number;
  minValue: number;
  maxValue: number;
};

export type StudyConfig = {
  env: Record<string, unknown>;
  metricsFile: string | null;
  metrics: OnchainMetricSpec[] | null;
  metricsSpecHash: string | null;
};

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const UINT32_MAX = 0xffffffff;
const MAX_METRIC_VALUE = 1_048_575;

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} object olmalidir`);
  }
  return value as Record<string, unknown>;
}

function bytes32(value: unknown, label: string): string {
  if (typeof value !== "string" || !BYTES32.test(value)) {
    throw new Error(`${label} bytes32 hex olmalidir`);
  }
  return value;
}

function isAnyAbsolutePath(value: string): boolean {
  return (
    isAbsolute(value) || posix.isAbsolute(value) || win32.isAbsolute(value)
  );
}

/** Hash the exact normalized struct sequence that is sent to configureMetrics. */
export function metricsSpecHash(metrics: OnchainMetricSpec[]): string {
  return keccak256(toUtf8Bytes(JSON.stringify(metrics)));
}

function uint32(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > UINT32_MAX
  ) {
    throw new Error(`${label} uint32 sayi olmalidir`);
  }
  return value;
}

export function validateOnchainMetrics(value: unknown): OnchainMetricSpec[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("METRICS_FILE bos olmayan JSON dizisi olmalidir");
  }

  return value.map((raw, index) => {
    const metric = objectOf(raw, `metric[${index}]`);
    const scale = uint32(metric.scale, `metric[${index}].scale`);
    const offset = uint32(metric.offset, `metric[${index}].offset`);
    const minValue = uint32(metric.minValue, `metric[${index}].minValue`);
    const maxValue = uint32(metric.maxValue, `metric[${index}].maxValue`);

    if (scale === 0) throw new Error(`metric[${index}].scale sifir olamaz`);
    if (minValue < 1 || minValue > maxValue || maxValue > MAX_METRIC_VALUE) {
      throw new Error(`metric[${index}] araligi gecersiz`);
    }

    return {
      code: bytes32(metric.code, `metric[${index}].code`).toLowerCase(),
      unit: bytes32(metric.unit, `metric[${index}].unit`).toLowerCase(),
      scale,
      offset,
      minValue,
      maxValue,
    };
  });
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} okunamadi: ${detail}`);
  }
}

/**
 * deploy-env.json ve METRICS_FILE'i ilk transaction'dan once dogrular.
 * Dosyadan gelen mutlak yollar kasitli olarak reddedilir: eski bir checkout'un
 * Unix/Windows yolu baska bir checkout'a tasinamaz.
 */
export function loadStudyConfig(
  studyEnvPath: string,
  options: { requireMetrics?: boolean; environment?: NodeJS.ProcessEnv } = {}
): StudyConfig {
  const environment = options.environment ?? process.env;
  const rawEnv = existsSync(studyEnvPath)
    ? objectOf(
        readJson(studyEnvPath, "study/deploy-env.json"),
        "study/deploy-env.json"
      )
    : {};
  const env: Record<string, unknown> = { ...rawEnv };

  for (const key of [
    "PANEL_HASH",
    "PANEL_URI",
    "SNP_COUNT",
    "METRICS_HASH",
    "METRICS_URI",
    "METRICS_FILE",
    "METRICS_SPEC_HASH",
  ]) {
    if (environment[key] !== undefined) env[key] = environment[key];
  }

  if (env.PANEL_HASH !== undefined && env.PANEL_HASH !== "") {
    bytes32(env.PANEL_HASH, "PANEL_HASH");
  }
  if (env.METRICS_HASH !== undefined && env.METRICS_HASH !== "") {
    bytes32(env.METRICS_HASH, "METRICS_HASH");
  }

  const rawMetricsPath = env.METRICS_FILE;
  if (rawMetricsPath === undefined || rawMetricsPath === "") {
    if (options.requireMetrics) {
      throw new Error("D15 deploy/resume icin METRICS_FILE zorunludur");
    }
    return { env, metricsFile: null, metrics: null, metricsSpecHash: null };
  }
  if (typeof rawMetricsPath !== "string") {
    throw new Error("METRICS_FILE string olmalidir");
  }

  const fromEnvironment = environment.METRICS_FILE !== undefined;
  if (!fromEnvironment && isAnyAbsolutePath(rawMetricsPath)) {
    throw new Error(
      "deploy-env METRICS_FILE mutlak yol olamaz; metrics-onchain.json goreli yolunu kullanin"
    );
  }

  const metricsFile = isAnyAbsolutePath(rawMetricsPath)
    ? rawMetricsPath
    : resolve(
        fromEnvironment ? process.cwd() : dirname(studyEnvPath),
        rawMetricsPath
      );
  if (!fromEnvironment) {
    const escaped = relative(dirname(studyEnvPath), metricsFile);
    if (
      escaped === ".." ||
      escaped.startsWith(`..${sep}`) ||
      isAbsolute(escaped)
    ) {
      throw new Error("deploy-env METRICS_FILE study dizini disina cikamaz");
    }
  }
  if (!existsSync(metricsFile)) {
    throw new Error(`METRICS_FILE bulunamadi: ${metricsFile}`);
  }
  const metrics = validateOnchainMetrics(readJson(metricsFile, "METRICS_FILE"));
  const computedSpecHash = metricsSpecHash(metrics);
  const configuredSpecHash = env.METRICS_SPEC_HASH;
  if (configuredSpecHash !== undefined && configuredSpecHash !== "") {
    bytes32(configuredSpecHash, "METRICS_SPEC_HASH");
    if (String(configuredSpecHash).toLowerCase() !== computedSpecHash) {
      throw new Error("METRICS_SPEC_HASH METRICS_FILE icerigiyle eslesmiyor");
    }
  } else if (options.requireMetrics) {
    throw new Error("D15 deploy/resume icin METRICS_SPEC_HASH zorunludur");
  }

  return { env, metricsFile, metrics, metricsSpecHash: computedSpecHash };
}
