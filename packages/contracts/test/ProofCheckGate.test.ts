import { expect } from "chai";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

describe("proof-check read-only startup gate", function () {
  this.timeout(20_000);

  for (const [label, additions, expected] of [
    ["missing profile", {}, "proof-check: D15_PROFILE zorunludur"],
    ["deployer key", { D15_PROFILE: "d15-sepolia-2of2-ml", DEPLOYER_PRIVATE_KEY: "forbidden-test-key" }, "signer/ack kabul etmez"],
    ["node key", { D15_PROFILE: "d15-sepolia-2of2-ml", NODE_PRIVATE_KEY: "forbidden-test-key" }, "signer/ack kabul etmez"],
    ["execution acknowledgement", { D15_PROFILE: "d15-sepolia-2of2-ml", D15_EXECUTION_ACK: "prepare" }, "signer/ack kabul etmez"],
  ] as const) {
    it(`rejects ${label} before FHE initialization`, () => {
      const env: NodeJS.ProcessEnv = { HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" };
      for (const [key, value] of Object.entries(process.env)) {
        if (/^(systemroot|windir|temp|tmp|path)$/i.test(key)) env[key] = value;
      }
      const result = spawnSync(process.execPath, [
        "--max-old-space-size=512",
        require.resolve("hardhat/internal/cli/cli"),
        "run", "--no-compile", "scripts/proof-check.ts", "--network", "sepolia",
      ], {
        cwd: join(__dirname, ".."), env: { ...env, ...additions },
        encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024,
      });
      expect(result.error).to.equal(undefined);
      expect(result.status).to.equal(1);
      expect(result.stderr).to.include(expected);
      expect(result.stdout).not.to.include("FHE CLI initialization");
      expect(result.stderr).not.to.include("forbidden-test-key");
    });
  }
});
