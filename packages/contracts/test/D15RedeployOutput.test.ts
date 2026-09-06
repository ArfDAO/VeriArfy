import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateOutputPair, withExecutionLock } from "../scripts/d15-redeploy";
import { assertPreviousDeployment, readPreviousDeployment, type RedeployPlan } from "../scripts/d15-redeploy-plan";

describe("D15 redeploy publication and lock", () => {
  it("rejects altered previous roots, topology and chain before constructing payloads", () => {
    const previous = readPreviousDeployment();
    for (const changed of [
      { ...previous, chainId: 1 }, { ...previous, initialRoot: "1" },
      { ...previous, accreditedRoot: "1" },
      { ...previous, contracts: { ...previous.contracts, VeriarfyStorage: previous.deployer } },
      { ...previous, contracts: { ...previous.contracts, PaymentToken: previous.deployer } },
    ]) assert.throws(() => assertPreviousDeployment(changed));
  });
  it("accepts the unchanged previous pair, rejects partial/different outputs without writes", () => {
    const root = mkdtempSync(join(tmpdir(), "d15-output-"));
    const paths = [join(root, "contract.json"), join(root, "web.json")] as const;
    try {
      const plan = {} as RedeployPlan; // previous/absent branches do not need a new plan
      assert.equal(validateOutputPair(plan, paths).state, "absent");
      assert.equal(existsSync(paths[0]), false);
      writeFileSync(paths[0], JSON.stringify(readPreviousDeployment()));
      assert.throws(() => validateOutputPair(plan, paths), /incomplete/);
      writeFileSync(paths[1], JSON.stringify(readPreviousDeployment()));
      assert.equal(validateOutputPair(plan, paths).state, "previous");
      writeFileSync(paths[1], "{}");
      assert.throws(() => validateOutputPair(plan, paths), /differs/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("excludes concurrent execute and releases only its own lock after errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "d15-lock-"));
    const path = join(root, "journal.json");
    try {
      await assert.rejects(withExecutionLock(path, async () => {
        assert.equal(existsSync(`${path}.lock`), true);
        await assert.rejects(withExecutionLock(path, async () => assert.fail("second executor ran")), /lock/);
        assert.equal(existsSync(`${path}.lock`), true);
        throw new Error("simulated action failure");
      }), /simulated action failure/);
      assert.equal(existsSync(`${path}.lock`), false);
      assert.equal(await withExecutionLock(path, async () => 42), 42);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
