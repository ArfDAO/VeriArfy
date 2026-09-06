import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Transaction, Wallet } from "ethers";
import { readJournal, submitJournaledStep, writeJournalAtomic } from "../scripts/d15-redeploy";
import { hashPlan, RedeployPlan } from "../scripts/d15-redeploy-plan";

function planFixture(deployer: string): RedeployPlan {
  return {
    version: 1, chainId: 11155111, deployer, startNonce: 24, endNonce: 25,
    maxFeePerGas: "2000000000", maxPriorityFeePerGas: "100000000", maxCostWei: "200000000000000",
    previousHash: `0x${"1".repeat(64)}`, keyLockHash: `0x${"2".repeat(64)}`,
    contracts: {}, reused: {},
    steps: [{ nonce: 24, label: "create", to: null, data: "0x1234", value: "0", gasLimit: "100000" }],
  };
}

function providerFixture(broadcastError?: Error, waitError?: Error): { provider: any; broadcasts: string[]; known: Map<string, any> } {
  const broadcasts: string[] = [];
  const known = new Map<string, any>();
  const provider = {
    getTransaction: async (hash: string) => known.get(hash) ?? null,
    broadcastTransaction: async (raw: string) => {
      broadcasts.push(raw);
      if (broadcastError) throw broadcastError;
      const parsed = Transaction.from(raw);
      assert.ok(parsed.hash, "fixture expects a signed transaction");
      const sent: any = {
        hash: parsed.hash, from: parsed.from, nonce: parsed.nonce, to: parsed.to, data: parsed.data,
        chainId: parsed.chainId, type: parsed.type, value: parsed.value, gasLimit: parsed.gasLimit,
        maxFeePerGas: parsed.maxFeePerGas, maxPriorityFeePerGas: parsed.maxPriorityFeePerGas,
        wait: async () => waitError ? Promise.reject(waitError) : ({ status: 1 }),
      };
      known.set(parsed.hash, sent);
      return sent;
    },
  };
  return { provider, broadcasts, known };
}

describe("D15 journaled submission", () => {
  it("persists the hash before broadcasting and does not rebroadcast a known transaction", async () => {
    const wallet = Wallet.createRandom();
    const plan = planFixture(wallet.address);
    const step = plan.steps[0];
    const root = mkdtempSync(join(tmpdir(), "d15-submit-test-"));
    try {
      const journalPath = join(root, "journal.json");
      const fixture = providerFixture();
      let durableBeforeBroadcast = false;
      const broadcast = fixture.provider.broadcastTransaction;
      fixture.provider.broadcastTransaction = async (raw: string) => {
        durableBeforeBroadcast = existsSync(journalPath) && readFileSync(journalPath, "utf8").includes("\"hash\"");
        return broadcast(raw);
      };
      const journal = { planHash: hashPlan(plan), entries: [] };
      await submitJournaledStep(plan, step, wallet, fixture.provider, journal, journalPath);
      assert.equal(durableBeforeBroadcast, true);
      assert.equal(fixture.broadcasts.length, 1);
      assert.equal(readFileSync(journalPath, "utf8").includes(wallet.privateKey), false);
      await submitJournaledStep(plan, step, wallet, fixture.provider, readJournal(journalPath)!, journalPath);
      assert.equal(fixture.broadcasts.length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a signed payload whose hash differs from the existing journal before broadcast", async () => {
    const wallet = Wallet.createRandom();
    const plan = planFixture(wallet.address);
    const fixture = providerFixture();
    const root = mkdtempSync(join(tmpdir(), "d15-submit-test-"));
    try {
      const journalPath = join(root, "journal.json");
      writeJournalAtomic({ planHash: hashPlan(plan), entries: [{ nonce: 24, hash: `0x${"f".repeat(64)}` }] }, journalPath);
      await assert.rejects(submitJournaledStep(plan, plan.steps[0], wallet, fixture.provider, readJournal(journalPath)!, journalPath), /signed hash differs/);
      assert.equal(fixture.broadcasts.length, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("redacts raw transactions and keys from broadcast and confirmation failures", async () => {
    const wallet = Wallet.createRandom();
    const plan = planFixture(wallet.address);
    const rawSecret = wallet.privateKey;
    const root = mkdtempSync(join(tmpdir(), "d15-submit-test-"));
    try {
      const broadcastPath = join(root, "broadcast.json");
      const broadcastFixture = providerFixture(new Error(`rawtx=${"ab".repeat(80)} key=${rawSecret}`));
      await assert.rejects(submitJournaledStep(plan, plan.steps[0], wallet, broadcastFixture.provider, { planHash: hashPlan(plan), entries: [] }, broadcastPath), (error: Error) => {
        assert.match(error.message, /broadcast unconfirmed/);
        assert.equal(error.message.includes(rawSecret), false);
        assert.equal(error.message.includes("ab".repeat(80)), false);
        return true;
      });

      const waitPath = join(root, "wait.json");
      const waitFixture = providerFixture(undefined, new Error(`rawtx=${"cd".repeat(80)} key=${rawSecret}`));
      await assert.rejects(submitJournaledStep(plan, plan.steps[0], wallet, waitFixture.provider, { planHash: hashPlan(plan), entries: [] }, waitPath), (error: Error) => {
        assert.match(error.message, /confirmation failed/);
        assert.equal(error.message.includes(rawSecret), false);
        assert.equal(error.message.includes("cd".repeat(80)), false);
        return true;
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a changed signed payload before any journal or broadcast", async () => {
    const wallet = Wallet.createRandom();
    const plan = planFixture(wallet.address);
    const fixture = providerFixture();
    const root = mkdtempSync(join(tmpdir(), "d15-submit-test-"));
    try {
      const journalPath = join(root, "journal.json");
      const wrongSigner = { signTransaction: (tx: any) => wallet.signTransaction({ ...tx, value: 1n }) };
      await assert.rejects(submitJournaledStep(plan, plan.steps[0], wrongSigner, fixture.provider, { planHash: hashPlan(plan), entries: [] }, journalPath), /value differs/);
      assert.equal(existsSync(journalPath), false);
      assert.equal(fixture.broadcasts.length, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
