/**
 * Pure parsing and state-transition helpers for the staged live check.
 *
 * This module deliberately has no Hardhat, dotenv, or contract imports.  It is
 * loaded by hardhat.config.ts as well as by the live-check script, so a typo in
 * the stage or an impossible approval transition can fail closed before any
 * network call or signer is used.
 */

export const LIVE_CHECK_QUERY_TYPES = [1, 2, 4] as const;
export type LiveCheckQueryType = (typeof LIVE_CHECK_QUERY_TYPES)[number];
export type LiveCheckStage = "prepare" | "node-1" | "node-2" | "complete";

const STAGES: readonly LiveCheckStage[] = ["prepare", "node-1", "node-2", "complete"];

export function parseLiveCheckStage(raw: string | undefined): LiveCheckStage {
  const value = raw?.trim();
  if (!value || !STAGES.includes(value as LiveCheckStage)) {
    throw new Error(
      "LIVE_CHECK_STAGE zorunludur ve prepare, node-1, node-2 veya complete olmalidir",
    );
  }
  return value as LiveCheckStage;
}

export function parseLiveCheckQueryType(raw: string | undefined): LiveCheckQueryType {
  const value = raw?.trim();
  if (!value || !/^[124]$/.test(value)) {
    throw new Error("LIVE_CHECK_QUERY_TYPE explicit olarak 1, 2 veya 4 olmalidir");
  }

  const queryType = Number(value) as LiveCheckQueryType;
  if (!LIVE_CHECK_QUERY_TYPES.includes(queryType)) {
    throw new Error("LIVE_CHECK_QUERY_TYPE explicit olarak 1, 2 veya 4 olmalidir");
  }
  return queryType;
}

/** Parse a decimal chain id supplied through an operator handoff. */
export function parseLiveCheckId(raw: string | undefined, name: string): bigint {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${name} zorunludur ve unsigned decimal bir id olmalidir`);
  }

  return BigInt(value);
}

export type ApprovalStageDecision = "submit" | "already-complete";

/**
 * Validate the only approval sequence supported by D/15.
 *
 * The caller separately checks `hasApproved` for the configured node
 * addresses; this helper intentionally reasons only about the public count
 * and finalized bit, which keeps it deterministic and easy to test.
 */
export function approvalStageDecision(
  stage: "node-1" | "node-2",
  approvals: bigint,
  finalized: boolean,
): ApprovalStageDecision {
  if (approvals < 0n) throw new Error("onay sayisi negatif olamaz");

  // A completed request is a valid idempotent result for either stage only
  // when the caller has already verified both expected node approvals.
  if (approvals === 2n && finalized) return "already-complete";
  if (finalized) {
    throw new Error(`${stage}: node-2 oncesi disclosure finalized olmus`);
  }

  if (stage === "node-1") {
    if (approvals === 0n) return "submit";
    if (approvals === 1n) return "already-complete";
    throw new Error("node-1: beklenmeyen onay sirasi");
  }

  if (approvals === 1n) return "submit";
  throw new Error("node-2: node-1 onayi olmadan ilerlenemez");
}

export function assertApprovalStageResult(
  stage: "node-1" | "node-2",
  approvals: bigint,
  finalized: boolean,
): void {
  const expected: readonly [bigint, boolean] =
    stage === "node-1" ? [1n, false] : [2n, true];
  if (approvals !== expected[0] || finalized !== expected[1]) {
    throw new Error(
      `${stage}: beklenmeyen zincir durumu (approvals=${approvals}, finalized=${finalized})`,
    );
  }
}

export function assertCompleteApprovalState(
  required: bigint,
  approvals: bigint,
  finalized: boolean,
  node1Approved: boolean,
  node2Approved: boolean,
): void {
  if (
    required !== 2n ||
    approvals !== 2n ||
    !finalized ||
    !node1Approved ||
    !node2Approved
  ) {
    throw new Error(
      `complete: D/15 approval kaniti gecersiz ` +
        `(required=${required}, approvals=${approvals}, finalized=${finalized}, ` +
        `node1=${node1Approved}, node2=${node2Approved})`,
    );
  }
}
