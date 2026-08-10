/**
 * Tarayici tarafi ZK yardimcilari — circuits paketiyle ayni Poseidon semasi.
 *   commitment    = Poseidon(trapdoor, nullifier)
 *   nullifierHash = Poseidon(externalNullifier, nullifier)
 *
 * Kanit uretimi `snarkjs` gerektirir; kurulu degilse anlamli bir hata verilir.
 * (Web paketinde snarkjs opsiyonel bagimliliktir.)
 */
import { poseidon2 } from "poseidon-lite";

export const SNARK_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const EXTERNAL_NULLIFIER = 1n;

export interface Identity {
  trapdoor: bigint;
  nullifier: bigint;
  commitment: bigint;
}

function randomFieldElement(): bigint {
  const buf = new Uint8Array(32);
  for (;;) {
    crypto.getRandomValues(buf);
    let hex = "0x";
    for (const b of buf) hex += b.toString(16).padStart(2, "0");
    const candidate = BigInt(hex);
    if (candidate < SNARK_FIELD) return candidate;
  }
}

export function createIdentity(): Identity {
  const trapdoor = randomFieldElement();
  const nullifier = randomFieldElement();
  return { trapdoor, nullifier, commitment: poseidon2([trapdoor, nullifier]) };
}

export function identityFromSecrets(trapdoor: bigint, nullifier: bigint): Identity {
  return { trapdoor, nullifier, commitment: poseidon2([trapdoor, nullifier]) };
}

export function computeNullifierHash(externalNullifier: bigint, nullifier: bigint): bigint {
  return poseidon2([externalNullifier, nullifier]);
}

/** Kimligi tarayici depolamasi icin serilestir. */
export function serializeIdentity(id: Identity): string {
  return JSON.stringify({
    trapdoor: id.trapdoor.toString(),
    nullifier: id.nullifier.toString(),
  });
}

export function deserializeIdentity(raw: string): Identity {
  const { trapdoor, nullifier } = JSON.parse(raw);
  return identityFromSecrets(BigInt(trapdoor), BigInt(nullifier));
}

export interface MerkleProofInput {
  siblings: string[];
  pathIndices: number[];
  root: bigint;
}

/**
 * snarkjs ile Groth16 kaniti uretir ve Solidity calldata'sina cevirir.
 * Kurator, kullanicinin taahhudu icin `MerkleProofInput`'u saglar.
 */
export async function generateProof(params: {
  identity: Identity;
  merkle: MerkleProofInput;
  signerAddress: string;
  wasmUrl: string;
  zkeyUrl: string;
}): Promise<{
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
  root: bigint;
  nullifierHash: bigint;
}> {
  let snarkjs: any;
  try {
    // Degisken specifier: TS statik cozmez, opsiyonel bagimlilik olarak kalir.
    const mod = "snarkjs";
    snarkjs = await import(/* @vite-ignore */ mod);
  } catch {
    throw new Error(
      "snarkjs kurulu degil. Tarayicida kanit uretmek icin `npm i snarkjs` calistirin.",
    );
  }

  const input = {
    identityTrapdoor: params.identity.trapdoor.toString(),
    identityNullifier: params.identity.nullifier.toString(),
    pathIndices: params.merkle.pathIndices.map(String),
    siblings: params.merkle.siblings.map(String),
    externalNullifier: EXTERNAL_NULLIFIER.toString(),
    signalHash: BigInt(params.signerAddress).toString(),
  };

  const { proof } = await snarkjs.groth16.fullProve(
    input,
    params.wasmUrl,
    params.zkeyUrl,
  );

  return {
    a: [proof.pi_a[0], proof.pi_a[1]],
    b: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    c: [proof.pi_c[0], proof.pi_c[1]],
    root: params.merkle.root,
    nullifierHash: computeNullifierHash(EXTERNAL_NULLIFIER, params.identity.nullifier),
  };
}
