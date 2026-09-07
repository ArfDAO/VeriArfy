import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

describe("D15 redeploy startup isolation", function () {
  this.timeout(20_000);
  for (const [script, extra, expected] of [
    ["d15-redeploy", {}, "D15_PROFILE zorunludur"],
    ["d15-redeploy", { D15_PROFILE: "d15-sepolia-2of2-ml", DEPLOYER_PRIVATE_KEY: "forbidden-key" }, "check signer kabul etmez"],
    ["d15-redeploy", { D15_PROFILE: "d15-sepolia-2of2-ml", D15_EXECUTION_ACK: "deploy" }, "D15_EXECUTION_ACK 'redeploy'"],
    ["d15-redeploy", { D15_PROFILE: "d15-sepolia-2of2-ml", D15_EXECUTION_ACK: "redeploy", DEPLOYER_PRIVATE_KEY: "forbidden-key", NODE_PRIVATE_KEY: "forbidden-key" }, "yalniz DEPLOYER_PRIVATE_KEY"],
    ["d15-redeploy-plan-write", { D15_PROFILE: "d15-sepolia-2of2-ml", D15_EXECUTION_ACK: "redeploy" }, "signer/ack kabul etmez"],
  ] as const) {
    it(`rejects unsafe ${script} environment ${JSON.stringify(Object.keys(extra))}`, () => {
      const env: NodeJS.ProcessEnv = { HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" };
      for (const [key, value] of Object.entries(process.env)) {
        if (/^(systemroot|windir|temp|tmp|path)$/i.test(key)) env[key] = value;
      }
      const result = spawnSync(process.execPath, ["--max-old-space-size=512",
        require.resolve("hardhat/internal/cli/cli"), "run", "--no-compile", `scripts/${script}.ts`, "--network", "sepolia",
      ], { cwd: join(__dirname, ".."), env: { ...env, ...extra }, encoding: "utf8", windowsHide: true, timeout: 15_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(expected), result.stderr);
      assert.ok(!result.stderr.includes("forbidden-key"));
    });
  }
});
