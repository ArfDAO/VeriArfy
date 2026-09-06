import { expect } from "chai";

import {
  approvalStageDecision,
  assertApprovalStageResult,
  assertCompleteApprovalState,
  parseLiveCheckId,
  parseLiveCheckQueryType,
  parseLiveCheckStage,
} from "../scripts/live-check-state";

describe("staged live-check state", () => {
  it("requires one of the explicit stages", () => {
    expect(parseLiveCheckStage("prepare")).to.equal("prepare");
    expect(parseLiveCheckStage("node-1")).to.equal("node-1");
    expect(parseLiveCheckStage("node-2")).to.equal("node-2");
    expect(parseLiveCheckStage("complete")).to.equal("complete");
    expect(() => parseLiveCheckStage(undefined)).to.throw();
    expect(() => parseLiveCheckStage("node1")).to.throw();
  });

  it("accepts only the deployed protocol query types", () => {
    expect(parseLiveCheckQueryType("1")).to.equal(1);
    expect(parseLiveCheckQueryType("2")).to.equal(2);
    expect(parseLiveCheckQueryType("4")).to.equal(4);
    expect(() => parseLiveCheckQueryType(undefined)).to.throw();
    expect(() => parseLiveCheckQueryType("3")).to.throw();
    expect(() => parseLiveCheckQueryType("01")).to.throw();
  });

  it("models the 0->1 and 1->2 approval sequence idempotently", () => {
    expect(approvalStageDecision("node-1", 0n, false)).to.equal("submit");
    expect(approvalStageDecision("node-1", 1n, false)).to.equal("already-complete");
    expect(approvalStageDecision("node-2", 1n, false)).to.equal("submit");
    expect(approvalStageDecision("node-1", 2n, true)).to.equal("already-complete");
    expect(approvalStageDecision("node-2", 2n, true)).to.equal("already-complete");
    expect(() => approvalStageDecision("node-2", 0n, false)).to.throw();
    expect(() => approvalStageDecision("node-1", 2n, false)).to.throw();
    expect(() => approvalStageDecision("node-1", 1n, true)).to.throw();

    expect(() => assertApprovalStageResult("node-1", 1n, false)).not.to.throw();
    expect(() => assertApprovalStageResult("node-2", 2n, true)).not.to.throw();
    expect(() => assertApprovalStageResult("node-2", 1n, false)).to.throw();
  });

  it("parses explicit non-negative decimal handoff ids", () => {
    expect(parseLiveCheckId("0", "LIVE_CHECK_REQUEST_ID")).to.equal(0n);
    expect(parseLiveCheckId("42", "LIVE_CHECK_QUERY_ID")).to.equal(42n);
    expect(() => parseLiveCheckId(undefined, "LIVE_CHECK_QUERY_ID")).to.throw();
    expect(() => parseLiveCheckId("-1", "LIVE_CHECK_QUERY_ID")).to.throw();
    expect(() => parseLiveCheckId("0x2a", "LIVE_CHECK_QUERY_ID")).to.throw();
  });

  it("requires the exact two configured approvals before complete", () => {
    expect(() =>
      assertCompleteApprovalState(2n, 2n, true, true, true),
    ).not.to.throw();
    expect(() => assertCompleteApprovalState(1n, 1n, true, true, false)).to.throw();
    expect(() => assertCompleteApprovalState(2n, 2n, false, true, true)).to.throw();
    expect(() => assertCompleteApprovalState(2n, 2n, true, true, false)).to.throw();
  });
});
