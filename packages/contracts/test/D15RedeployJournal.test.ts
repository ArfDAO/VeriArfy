import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  inspectProgress,
  readJournal,
  writeJournalAtomic,
} from "../scripts/d15-redeploy";
import { hashPlan, RedeployPlan, RedeployStep } from "../scripts/d15-redeploy-plan";

const DEPLOYER = "0x836091aB39884BB57DB4Dd94Ee120286Ad7e4fe0";

function planFixture(): RedeployPlan {
  const step = (nonce: number, data: string): RedeployStep => ({
    nonce, label: `step-${nonce}`, to: null, data, value: "0", gasLimit: "100000", address: `0x${String(nonce).padStart(40, "0")}`,
  });
  return {
    version: 1, chainId: 11155111, deployer: DEPLOYER, startNonce: 24, endNonce: 26,
    maxFeePerGas: "2000000000", maxPriorityFeePerGas: "100000000", maxCostWei: "400000000000000",
    previousHash: `0x${"1".repeat(64)}`, keyLockHash: `0x${"2".repeat(64)}`, contracts: {}, reused: {},
    steps: [step(24, "0xaaaa"), step(25, "0xbbbb")],
  };
}

function txFor(plan: RedeployPlan, step: RedeployStep, hash: string): any {
  return { hash, from: plan.deployer, nonce: step.nonce, to: null, data: step.data, chainId: plan.chainId, type: 2,
    value: 0n, gasLimit: BigInt(step.gasLimit), maxFeePerGas: BigInt(plan.maxFeePerGas), maxPriorityFeePerGas: BigInt(plan.maxPriorityFeePerGas) };
}

function providerFixture(plan: RedeployPlan, latest: number, pending: number, txs: any[] = [], receipts: any[] = []): any {
  const byHash = new Map(txs.map((tx) => [tx.hash, tx]));
  const byReceipt = new Map(receipts.map((receipt) => [receipt.transactionHash, receipt]));
  return {
    getTransactionCount: async (_address: string, tag: string) => tag === "latest" ? latest : pending,
    getTransaction: async (hash: string) => byHash.get(hash) ?? null,
    getTransactionReceipt: async (hash: string) => byReceipt.get(hash) ?? null,
  };
}

describe("D15 redeploy journal predicates", () => {
  it("writes only plan hash and nonce/hash entries atomically", () => {
    const root = mkdtempSync(join(tmpdir(), "d15-journal-test-"));
    try {
      const journal = { planHash: `0x${"a".repeat(64)}`, entries: [{ nonce: 24, hash: `0x${"b".repeat(64)}` }] };
      const path = join(root, "journal.json");
      writeJournalAtomic(journal, path);
      assert.deepEqual(readJournal(path), journal);
      assert.equal(existsSync(`${path}.tmp`), false);
      assert.equal(readFileSync(path, "utf8").includes("raw"), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("accepts a verified receipt and an explicitly journaled pending transaction", async () => {
    const plan = planFixture();
    const firstHash = `0x${"1".repeat(64)}`;
    const secondHash = `0x${"2".repeat(64)}`;
    const tx1 = txFor(plan, plan.steps[0], firstHash);
    const tx2 = txFor(plan, plan.steps[1], secondHash);
    const provider = providerFixture(plan, 25, 26, [tx1, tx2], [{ transactionHash: firstHash, status: 1, blockNumber: 100, contractAddress: plan.steps[0].address }]);
    const root = mkdtempSync(join(tmpdir(), "d15-journal-test-"));
    try {
      const journalPath = join(root, "journal.json");
      writeJournalAtomic({ planHash: hashPlan(plan), entries: [{ nonce: 24, hash: firstHash }, { nonce: 25, hash: secondHash }] }, journalPath);
      const progress = await inspectProgress(plan, provider, journalPath);
      assert.deepEqual([...progress.completed], [24]);
      assert.deepEqual([...progress.pending], [25]);
      assert.equal(progress.receipts[0].blockNumber, 100);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed when a consumed nonce has no verified receipt", async () => {
    const plan = planFixture();
    const root = mkdtempSync(join(tmpdir(), "d15-journal-test-"));
    try {
      const journalPath = join(root, "journal.json");
      const missingHash = `0x${"3".repeat(64)}`;
      writeJournalAtomic({ planHash: hashPlan(plan), entries: [{ nonce: 24, hash: missingHash }] }, journalPath);
      await assert.rejects(inspectProgress(plan, providerFixture(plan, 25, 25), journalPath), /consumed without verified receipt/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed when the journal transaction differs from the fixed plan", async () => {
    const plan = planFixture();
    const hash = `0x${"4".repeat(64)}`;
    const tx = txFor(plan, plan.steps[0], hash);
    tx.data = "0xdead";
    const root = mkdtempSync(join(tmpdir(), "d15-journal-test-"));
    try {
      const journalPath = join(root, "journal.json");
      writeJournalAtomic({ planHash: hashPlan(plan), entries: [{ nonce: 24, hash }] }, journalPath);
      await assert.rejects(inspectProgress(plan, providerFixture(plan, 24, 24, [tx]), journalPath), /transaction differs from plan/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("requires journal entries to form an ordered nonce prefix", async () => {
    const plan = planFixture();
    const hash = `0x${"5".repeat(64)}`;
    const root = mkdtempSync(join(tmpdir(), "d15-journal-test-"));
    try {
      const journalPath = join(root, "journal.json");
      assert.throws(() => writeJournalAtomic({ planHash: hashPlan(plan), entries: [{ nonce: 25, hash }] }, journalPath), /nonce\/hash gecersiz/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects journal entries outside the fixed plan nonce range", async () => {
    const plan = planFixture();
    const root = mkdtempSync(join(tmpdir(), "d15-journal-test-"));
    try {
      const journalPath = join(root, "journal.json");
      assert.throws(() => writeJournalAtomic({ planHash: hashPlan(plan), entries: [{ nonce: 42, hash: `0x${"6".repeat(64)}` }] }, journalPath), /nonce\/hash gecersiz/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a journal hash that does not identify the returned transaction", async () => {
    const plan = planFixture();
    const journalHash = `0x${"7".repeat(64)}`;
    const actualHash = `0x${"8".repeat(64)}`;
    const tx = txFor(plan, plan.steps[0], actualHash);
    const root = mkdtempSync(join(tmpdir(), "d15-journal-test-"));
    try {
      const journalPath = join(root, "journal.json");
      writeJournalAtomic({ planHash: hashPlan(plan), entries: [{ nonce: 24, hash: journalHash }] }, journalPath);
      const provider = {
        getTransactionCount: async (_address: string, tag: string) => tag === "latest" ? 24 : 24,
        getTransaction: async (_hash: string) => tx,
        getTransactionReceipt: async (_hash: string) => null,
      };
      await assert.rejects(inspectProgress(plan, provider, journalPath), /transaction hash mismatch/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects an unknown pending frontier transaction", async () => {
    const plan = planFixture();
    const root = mkdtempSync(join(tmpdir(), "d15-journal-test-"));
    try {
      const journalPath = join(root, "journal.json");
      writeJournalAtomic({ planHash: hashPlan(plan), entries: [] }, journalPath);
      await assert.rejects(inspectProgress(plan, providerFixture(plan, 24, 25), journalPath), /unexpected pending nonce 24/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a journal whose plan hash is not the canonical plan hash", async () => {
    const plan = planFixture();
    const root = mkdtempSync(join(tmpdir(), "d15-journal-test-"));
    try {
      const journalPath = join(root, "journal.json");
      writeJournalAtomic({ planHash: `0x${"9".repeat(64)}`, entries: [] }, journalPath);
      await assert.rejects(inspectProgress(plan, providerFixture(plan, 24, 24), journalPath), /planHash mismatch/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
