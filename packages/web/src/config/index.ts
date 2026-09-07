import deployment from "./deployment.json";
import { IDENTITY_CIRCUIT_WASM, IDENTITY_CIRCUIT_ZKEY } from "./circuits";

export {
  IDENTITY_CIRCUIT_WASM,
  IDENTITY_CIRCUIT_ZKEY,
  PROVENANCE_CIRCUIT_WASM,
  PROVENANCE_CIRCUIT_ZKEY,
} from "./circuits";

export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_HEX = "0xaa36a7";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const CONTRACTS = deployment.contracts as {
  Groth16Verifier: string;
  DataProvenanceVerifier: string;
  VeriarfyProtocol: string;
  VeriarfyPayments: string;
  PaymentToken: string;
  VeriArfyRegistry: string;
  AnxietyStudy: string;
  /** Rapor §2.7 — kripto-ekonomik guvenlik modulu. */
  VeriarfyStaking?: string;
  /** Rapor §2.9.2 — Filecoin kalicilik defteri. */
  VeriarfyStorage?: string;
  /** Veri kategorisi 2 — surekli biyobelirtec kanali. */
  VeriarfyBiomarkers?: string;
};

/** Kontratlar deploy edilmis mi? */
export const isDeployed =
  CONTRACTS.VeriArfyRegistry !== ZERO_ADDRESS &&
  CONTRACTS.AnxietyStudy !== ZERO_ADDRESS;

/** Protokol ve odeme katmani deploy edilmis mi? */
export const isProtocolDeployed =
  !!CONTRACTS.VeriarfyProtocol &&
  CONTRACTS.VeriarfyProtocol !== ZERO_ADDRESS &&
  !!CONTRACTS.VeriarfyPayments &&
  CONTRACTS.VeriarfyPayments !== ZERO_ADDRESS;

/** Zincir uzerindeki islemi Etherscan'de acar. */
export function explorerTx(hash: string): string {
  return `https://sepolia.etherscan.io/tx/${hash}`;
}

export function explorerAddress(address: string): string {
  return `https://sepolia.etherscan.io/address/${address}`;
}

/** Kurator servisi — Merkle yolunu saglar (VITE_CURATOR_URL ile degistirilebilir). */
export const CURATOR_URL = import.meta.env.VITE_CURATOR_URL ?? "http://localhost:8787";

/** Devre ciktilarinin sunuldugu yol. */
export const CIRCUIT_WASM = IDENTITY_CIRCUIT_WASM;
export const CIRCUIT_ZKEY = IDENTITY_CIRCUIT_ZKEY;

export { deployment };
