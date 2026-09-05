import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect } from "chai";

import {
  loadStudyConfig,
  metricsSpecHash,
  validateOnchainMetrics,
} from "../scripts/study-config";

describe("portable study deployment config", () => {
  it("resolves the generated relative metrics path beside deploy-env.json", () => {
    const envPath = join(__dirname, "..", "study", "deploy-env.json");
    const config = loadStudyConfig(envPath, {
      requireMetrics: true,
      environment: {},
    });
    expect(config.metricsFile).to.equal(
      join(__dirname, "..", "study", "metrics-onchain.json")
    );
    expect(config.metrics).to.have.length(6);
    expect(config.metricsSpecHash).to.equal(
      "0x32a754a73e1bf6aadc967f21bfcb1ab420a957f47bc3cb17a2ec6fea755c0b67"
    );
  });

  it("rejects a foreign absolute path from deploy-env before use", () => {
    const root = mkdtempSync(join(tmpdir(), "veriarfy-study-config-"));
    try {
      const envPath = join(root, "deploy-env.json");
      writeFileSync(
        envPath,
        JSON.stringify({ METRICS_FILE: "/Users/other/metrics-onchain.json" })
      );
      expect(() =>
        loadStudyConfig(envPath, { requireMetrics: true, environment: {} })
      ).to.throw("mutlak yol olamaz");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects empty and malformed metric specifications", () => {
    expect(() => validateOnchainMetrics([])).to.throw("bos olmayan");
    expect(() =>
      validateOnchainMetrics([
        {
          code: "0x00",
          unit: "0x00",
          scale: 1,
          offset: 0,
          minValue: 1,
          maxValue: 2,
        },
      ])
    ).to.throw("bytes32");
    expect(() =>
      validateOnchainMetrics([
        {
          code: `0x${"00".repeat(32)}`,
          unit: `0x${"00".repeat(32)}`,
          scale: 0,
          offset: 0,
          minValue: 1,
          maxValue: 2,
        },
      ])
    ).to.throw("sifir");
  });

  it("binds the deploy-env hash to the exact normalized metric content", () => {
    const root = mkdtempSync(join(tmpdir(), "veriarfy-study-hash-"));
    try {
      const envPath = join(root, "deploy-env.json");
      const metricPath = join(root, "metrics.json");
      const metric = [
        {
          code: `0x${"11".repeat(32)}`,
          unit: `0x${"22".repeat(32)}`,
          scale: 1,
          offset: 0,
          minValue: 1,
          maxValue: 2,
        },
      ];
      writeFileSync(metricPath, JSON.stringify(metric));
      writeFileSync(
        envPath,
        JSON.stringify({
          METRICS_FILE: "metrics.json",
          METRICS_SPEC_HASH: metricsSpecHash(metric),
        })
      );
      expect(
        loadStudyConfig(envPath, { requireMetrics: true, environment: {} })
          .metricsSpecHash
      ).to.equal(metricsSpecHash(metric));
      writeFileSync(
        metricPath,
        JSON.stringify([{ ...metric[0], maxValue: 3 }])
      );
      expect(() =>
        loadStudyConfig(envPath, { requireMetrics: true, environment: {} })
      ).to.throw("icerigiyle eslesmiyor");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves relative process-env paths from cwd and rejects POSIX/Windows foreign paths", () => {
    const root = mkdtempSync(join(tmpdir(), "veriarfy-study-path-"));
    const cwdFile = `veriarfy-metrics-${process.pid}.json`;
    const cwdPath = join(process.cwd(), cwdFile);
    const metric = [
      {
        code: `0x${"33".repeat(32)}`,
        unit: `0x${"44".repeat(32)}`,
        scale: 1,
        offset: 0,
        minValue: 1,
        maxValue: 2,
      },
    ];
    try {
      writeFileSync(cwdPath, JSON.stringify(metric));
      const envPath = join(root, "deploy-env.json");
      writeFileSync(envPath, JSON.stringify({}));
      const loaded = loadStudyConfig(envPath, {
        requireMetrics: true,
        environment: {
          METRICS_FILE: cwdFile,
          METRICS_SPEC_HASH: metricsSpecHash(metric),
        },
      });
      expect(loaded.metricsFile).to.equal(cwdPath);
      writeFileSync(
        envPath,
        JSON.stringify({
          METRICS_FILE: "../metrics.json",
          METRICS_SPEC_HASH: metricsSpecHash(metric),
        })
      );
      expect(() =>
        loadStudyConfig(envPath, { requireMetrics: true, environment: {} })
      ).to.throw("study dizini disina");
      writeFileSync(
        envPath,
        JSON.stringify({
          METRICS_FILE: "C:\\Users\\other\\metrics.json",
          METRICS_SPEC_HASH: metricsSpecHash(metric),
        })
      );
      expect(() =>
        loadStudyConfig(envPath, { requireMetrics: true, environment: {} })
      ).to.throw("mutlak yol olamaz");
    } finally {
      try {
        unlinkSync(cwdPath);
      } catch {
        /* test file may not exist */
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
