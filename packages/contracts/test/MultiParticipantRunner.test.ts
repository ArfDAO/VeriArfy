import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emptyD17State,
  loadD17State,
  recordTx,
  saveD17State,
  withD17StateLock,
} from "../scripts/multi-participant-state";
import { findConfirmedResearcherOpenJournal } from "../scripts/multi-participant-check";

describe("D/17 public state runner", () => {
  it("round-trips only public resumable state", () => {
    const dir = mkdtempSync(join(tmpdir(), "veriarfy-d17-"));
    const path = join(dir, "state.json");
    try {
      const state = emptyD17State();
      state.participants["0xparticipant"] = {
        role: "participant-1",
        address: "0x0000000000000000000000000000000000000001",
        coverage: [0, 1],
        commitment: "123456789",
        txs: [],
      };
      recordTx(state, {
        kind: "fund-participant",
        role: "node-1",
        from: "0x0000000000000000000000000000000000000002",
        to: "0x0000000000000000000000000000000000000001",
        hash: "0x" + "22".repeat(32),
        nonce: 0,
        valueWei: "18000000000000000",
        gasLimit: "21000",
        maxFeePerGas: "2000000000",
        maxPriorityFeePerGas: "100000000",
        status: "confirmed",
      });
      saveD17State(path, state);
      const loaded = loadD17State(path);
      assert.equal(loaded.profile, "d17-sepolia-multi-participant-v1");
      assert.equal(loaded.txs[0].hash, "0x" + "22".repeat(32));
      assert.equal(loaded.participants["0xparticipant"].commitment, "123456789");
      assert.equal((loaded as unknown as Record<string, unknown>).privateKey, undefined);
      assert.equal((loaded as unknown as Record<string, unknown>).witness, undefined);
      assert.equal((loaded as unknown as Record<string, unknown>).salt, undefined);
      assert.throws(() => saveD17State(path, { ...loaded, privateKey: "0xdeadbeef" } as never), /secret\/raw transaction/);
      assert.throws(() => saveD17State(path, {
        ...loaded,
        participants: {
          ...loaded.participants,
          "0xparticipant": { ...loaded.participants["0xparticipant"], commitment: "0x" + "11".repeat(32) },
        },
      }), /decimal|uint256/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a second writer while the state lock is held", () => {
    const dir = mkdtempSync(join(tmpdir(), "veriarfy-d17-lock-"));
    const path = join(dir, "state.json");
    try {
      assert.throws(() => withD17StateLock(path, () => withD17StateLock(path, () => undefined)), /lock/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed transaction hashes", () => {
    assert.throws(() => recordTx(emptyD17State(), {
      kind: "bad",
      role: "participant-1",
      from: "0x0000000000000000000000000000000000000001",
      hash: "0x1234",
      status: "broadcast",
    }), /transaction hash/);
  });

  it("recovers the confirmed query journal when nextQueryId has already advanced", () => {
    const state = emptyD17State();
    const journal = {
      kind: "researcher-open-query",
      role: "deployer",
      from: "0x0000000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002",
      hash: "0x" + "33".repeat(32),
      nonce: 4,
      expectedQueryId: "4",
      expectedRequestId: "7",
      status: "confirmed" as const,
    };
    state.txs.push(journal);
    const recovered = findConfirmedResearcherOpenJournal(state);
    assert.equal(recovered?.hash, journal.hash);
    assert.equal(recovered?.expectedQueryId, "4");
    assert.equal(recovered?.expectedRequestId, "7");
  });
});
