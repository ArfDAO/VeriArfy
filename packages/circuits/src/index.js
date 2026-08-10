/**
 * VeriArfy kimlik yardimcilari.
 *
 * Devre ile birebir ayni Poseidon semasini kullanir:
 *   commitment    = Poseidon(trapdoor, nullifier)
 *   nullifierHash = Poseidon(externalNullifier, nullifier)
 *   merkle dugum  = Poseidon(sol, sag)
 */
import { randomBytes } from "node:crypto";

import { poseidon2 } from "poseidon-lite";

/** BN254 skaler alan mertebesi. */
export const SNARK_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const TREE_DEPTH = 20;

/** Alan icine sigan rastgele bir eleman uretir. */
export function randomFieldElement() {
  // 32 bayti mod alarak kucuk bir sapma olusur; 2^256 / p orani nedeniyle
  // pratikte ihmal edilebilir, yine de reddetme ornekleme ile temizliyoruz.
  for (;;) {
    const candidate = BigInt(`0x${randomBytes(32).toString("hex")}`);
    if (candidate < SNARK_FIELD) {
      return candidate;
    }
  }
}

/** Yeni bir arastirmaci kimligi uretir. Bu degerler gizli tutulmalidir. */
export function createIdentity() {
  const trapdoor = randomFieldElement();
  const nullifier = randomFieldElement();
  return {
    trapdoor,
    nullifier,
    commitment: poseidon2([trapdoor, nullifier]),
  };
}

/** Gizli anahtarlardan kimligi yeniden turetir. */
export function identityFromSecrets(trapdoor, nullifier) {
  const t = BigInt(trapdoor);
  const n = BigInt(nullifier);
  return { trapdoor: t, nullifier: n, commitment: poseidon2([t, n]) };
}

/** Kapsam basina tek kullanimlik nullifier hash'i. */
export function computeNullifierHash(externalNullifier, identityNullifier) {
  return poseidon2([BigInt(externalNullifier), BigInt(identityNullifier)]);
}

/**
 * Cuzdan adresini devrenin `signalHash` sinyaline cevirir.
 * Adres 160 bit oldugu icin alana dogrudan sigar; kontrat tarafinda
 * `uint256(uint160(msg.sender))` ile birebir eslesir.
 */
export function addressToSignalHash(address) {
  return BigInt(address);
}

/** Bos alt agaclarin onceden hesaplanmis kokleri. */
function zeroHashes(depth) {
  const zeros = [0n];
  for (let i = 1; i <= depth; i++) {
    zeros.push(poseidon2([zeros[i - 1], zeros[i - 1]]));
  }
  return zeros;
}

/**
 * Sabit derinlikli, sadece-ekleme yapilan Merkle agaci.
 * Akredite arastirmaci taahhutlerini tutar.
 */
export class IdentityTree {
  constructor(depth = TREE_DEPTH) {
    this.depth = depth;
    this.zeros = zeroHashes(depth);
    // layers[0] = yapraklar
    this.layers = Array.from({ length: depth + 1 }, () => []);
  }

  get leaves() {
    return this.layers[0];
  }

  get root() {
    return this.layers[this.depth][0] ?? this.zeros[this.depth];
  }

  indexOf(commitment) {
    return this.leaves.findIndex((leaf) => leaf === BigInt(commitment));
  }

  insert(commitment) {
    const leaf = BigInt(commitment);
    if (this.leaves.length >= 2 ** this.depth) {
      throw new Error("agac dolu");
    }
    this.layers[0].push(leaf);
    this.#rebuildFrom(this.layers[0].length - 1);
    return this.leaves.length - 1;
  }

  #rebuildFrom(leafIndex) {
    let index = leafIndex;
    for (let level = 0; level < this.depth; level++) {
      const layer = this.layers[level];
      const siblingIndex = index ^ 1;
      const node = layer[index] ?? this.zeros[level];
      const sibling = layer[siblingIndex] ?? this.zeros[level];

      const [left, right] = index % 2 === 0 ? [node, sibling] : [sibling, node];
      const parentIndex = index >> 1;
      this.layers[level + 1][parentIndex] = poseidon2([left, right]);
      index = parentIndex;
    }
  }

  /** Bir yaprak icin Merkle kanitini (siblings + pathIndices) uretir. */
  proof(leafIndex) {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new Error(`gecersiz yaprak indeksi: ${leafIndex}`);
    }

    const siblings = [];
    const pathIndices = [];
    let index = leafIndex;

    for (let level = 0; level < this.depth; level++) {
      const layer = this.layers[level];
      const siblingIndex = index ^ 1;
      siblings.push(layer[siblingIndex] ?? this.zeros[level]);
      pathIndices.push(index % 2);
      index >>= 1;
    }

    return { leaf: this.leaves[leafIndex], siblings, pathIndices, root: this.root };
  }
}

/** Devreye verilecek tam tanik (witness) girdisini hazirlar. */
export function buildCircuitInput({ identity, tree, externalNullifier, signerAddress }) {
  const leafIndex = tree.indexOf(identity.commitment);
  if (leafIndex === -1) {
    throw new Error("kimlik taahhudu agacta bulunamadi");
  }

  const { siblings, pathIndices } = tree.proof(leafIndex);

  return {
    identityTrapdoor: identity.trapdoor.toString(),
    identityNullifier: identity.nullifier.toString(),
    pathIndices: pathIndices.map(String),
    siblings: siblings.map(String),
    externalNullifier: BigInt(externalNullifier).toString(),
    signalHash: addressToSignalHash(signerAddress).toString(),
  };
}

/**
 * snarkjs kanitini Solidity Groth16Verifier'in bekledigi
 * (a, b, c) bicimine cevirir.
 */
export function toSolidityCalldata(proof) {
  return {
    a: [proof.pi_a[0], proof.pi_a[1]],
    // Solidity tarafinda G2 elemanlarinin koordinatlari ters sirada beklenir.
    b: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    c: [proof.pi_c[0], proof.pi_c[1]],
  };
}
