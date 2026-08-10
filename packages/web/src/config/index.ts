import deployment from "./deployment.json";

export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_HEX = "0xaa36a7";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const CONTRACTS = deployment.contracts as {
  Groth16Verifier: string;
  VeriArfyRegistry: string;
  AnxietyStudy: string;
};

/** Kontratlar deploy edilmis mi? */
export const isDeployed =
  CONTRACTS.VeriArfyRegistry !== ZERO_ADDRESS &&
  CONTRACTS.AnxietyStudy !== ZERO_ADDRESS;

/** Kurator servisi — Merkle yolunu saglar (VITE_CURATOR_URL ile degistirilebilir). */
export const CURATOR_URL = import.meta.env.VITE_CURATOR_URL ?? "http://localhost:8787";

/** Devre ciktilarinin sunuldugu yol. */
export const CIRCUIT_WASM = "/circuits/researcher_identity.wasm";
export const CIRCUIT_ZKEY = "/circuits/researcher_identity_final.zkey";

export { deployment };
