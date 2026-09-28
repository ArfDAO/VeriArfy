import { expect } from "chai";
import { d17SigningKey } from "../scripts/d17-signing-config";

describe("D17 isolated signing configuration", () => {
  // Public deterministic fixture; never funded or used on a live network.
  const key = "11".repeat(32);
  const execution = {
    D17_STAGE: "contribute",
    D17_ROLE: "participant-1",
    D17_EXECUTE: "1",
    D17_PRIVATE_KEY: key,
  };

  it("leaves ordinary and D15 configurations unchanged", () => {
    expect(d17SigningKey(false, {})).to.equal(null);
    expect(d17SigningKey(false, { D15_PROFILE: "d15-sepolia-2of2-ml" })).to.equal(null);
  });

  it("rejects D17 signing context in unrelated invocations", () => {
    for (const name of ["D17_PRIVATE_KEY", "D17_EXECUTE", "D17_ROLE", "D17_STAGE"]) {
      expect(() => d17SigningKey(false, { [name]: "set" })).to.throw("requires multi-participant-check");
    }
  });

  it("allows preflight without any signer and rejects a key even without execution", () => {
    expect(d17SigningKey(true, { D17_STAGE: "preflight", D17_ROLE: "none" })).to.equal("");
    expect(() => d17SigningKey(true, { D17_STAGE: "preflight", D17_PRIVATE_KEY: key }))
      .to.throw("read-only invocation cannot load a signer");
  });

  it("accepts only one explicit role signer for execution", () => {
    expect(d17SigningKey(true, execution)).to.equal(`0x${key}`);
    for (const name of ["DEPLOYER_PRIVATE_KEY", "NODE_PRIVATE_KEY", "OTHER_PRIVATE_KEY", "MNEMONIC", "D15_PROFILE", "LIVE_CHECK_STAGE"]) {
      expect(() => d17SigningKey(true, { ...execution, [name]: "sensitive-value" }))
        .to.throw("isolated single-role environment");
    }
  });

  it("fails closed on missing, malformed or ambiguous execution inputs", () => {
    for (const patch of [
      { D17_PRIVATE_KEY: "" }, { D17_PRIVATE_KEY: "malformed-secret" },
      { D17_PRIVATE_KEY: "00".repeat(32) }, { D17_PRIVATE_KEY: "ff".repeat(32) },
      { D17_ROLE: "none" }, { D17_ROLE: "node-3" }, { D17_ROLE: "participant-6" },
      { D17_EXECUTE: "0" }, { D17_STAGE: "" }, { D17_STAGE: "../deploy" },
    ]) {
      expect(() => d17SigningKey(true, { ...execution, ...patch })).to.throw();
    }
  });

  it("never includes rejected key contents in errors", () => {
    const secret = "malformed-secret-do-not-print";
    try {
      d17SigningKey(true, { ...execution, D17_PRIVATE_KEY: secret });
      expect.fail("invalid key accepted");
    } catch (error) {
      expect(String(error)).not.to.contain(secret);
    }
  });
});
