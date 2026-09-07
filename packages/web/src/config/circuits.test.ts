import { describe, expect, it } from "vitest";

import artifacts from "../../../circuits/artifacts.lock.json";
import {
  IDENTITY_CIRCUIT_WASM,
  IDENTITY_CIRCUIT_ZKEY,
  PROVENANCE_CIRCUIT_WASM,
  PROVENANCE_CIRCUIT_ZKEY,
} from "./circuits";

describe("versioned circuit URLs", () => {
  it("pins every default download to its locked artifact hash", () => {
    expect(IDENTITY_CIRCUIT_WASM).toBe(
      `/circuits/researcher_identity.wasm?v=${artifacts.circuits.identity.sha256.wasm}`,
    );
    expect(IDENTITY_CIRCUIT_ZKEY).toBe(
      `/circuits/researcher_identity_final.zkey?v=${artifacts.circuits.identity.sha256.zkey}`,
    );
    expect(PROVENANCE_CIRCUIT_WASM).toBe(
      `/circuits/data_provenance.wasm?v=${artifacts.circuits.provenance.sha256.wasm}`,
    );
    expect(PROVENANCE_CIRCUIT_ZKEY).toBe(
      `/circuits/data_provenance_final.zkey?v=${artifacts.circuits.provenance.sha256.zkey}`,
    );
  });
});
