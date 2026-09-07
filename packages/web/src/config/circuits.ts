import artifacts from "../../../circuits/artifacts.lock.json";

const versioned = (path: string, sha256: string): string => `${path}?v=${sha256}`;

export const IDENTITY_CIRCUIT_WASM = versioned(
  "/circuits/researcher_identity.wasm",
  artifacts.circuits.identity.sha256.wasm,
);
export const IDENTITY_CIRCUIT_ZKEY = versioned(
  "/circuits/researcher_identity_final.zkey",
  artifacts.circuits.identity.sha256.zkey,
);
export const PROVENANCE_CIRCUIT_WASM = versioned(
  "/circuits/data_provenance.wasm",
  artifacts.circuits.provenance.sha256.wasm,
);
export const PROVENANCE_CIRCUIT_ZKEY = versioned(
  "/circuits/data_provenance_final.zkey",
  artifacts.circuits.provenance.sha256.zkey,
);
