pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/mux1.circom";

/*
 * Bir yaprağın Merkle ağacında bulunduğunu kanıtlar.
 * pathIndices[i] == 0  -> mevcut hash solda
 * pathIndices[i] == 1  -> mevcut hash sağda
 */
template MerkleTreeInclusionProof(nLevels) {
    signal input leaf;
    signal input pathIndices[nLevels];
    signal input siblings[nLevels];

    signal output root;

    component hashers[nLevels];
    component mux[nLevels];

    signal hashes[nLevels + 1];
    hashes[0] <== leaf;

    for (var i = 0; i < nLevels; i++) {
        // pathIndices ikili olmak zorunda
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        hashers[i] = Poseidon(2);
        mux[i] = MultiMux1(2);

        mux[i].c[0][0] <== hashes[i];
        mux[i].c[0][1] <== siblings[i];

        mux[i].c[1][0] <== siblings[i];
        mux[i].c[1][1] <== hashes[i];

        mux[i].s <== pathIndices[i];

        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];

        hashes[i + 1] <== hashers[i].out;
    }

    root <== hashes[nLevels];
}

/*
 * VeriArfy araştırmacı kimlik devresi.
 *
 * Kanıtlanan iddia:
 *   "Akredite araştırmacı listesinde (Merkle kökü `root`) yer alan bir kimliğin
 *    gizli anahtarlarını biliyorum ve bu kanıtı `signalHash` cüzdanına bağlıyorum."
 *
 * Gizli girdiler kimliği açığa çıkarmaz; `nullifierHash` yalnızca aynı kimliğin
 * aynı kapsamda (externalNullifier) ikinci kez kayıt olmasını engeller.
 *
 * Public sinyal sırası (snarkjs): [root, nullifierHash, externalNullifier, signalHash]
 */
template ResearcherIdentity(nLevels) {
    // --- gizli girdiler ---
    signal input identityTrapdoor;
    signal input identityNullifier;
    signal input pathIndices[nLevels];
    signal input siblings[nLevels];

    // --- açık girdiler ---
    signal input externalNullifier; // kayıt kapsamı (registry sürümü)
    signal input signalHash;        // cüzdan adresine bağlanır

    // --- çıktılar (açık sinyal olur) ---
    signal output root;
    signal output nullifierHash;

    // kimlik taahhüdü = Poseidon(trapdoor, nullifier)
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== identityTrapdoor;
    commitmentHasher.inputs[1] <== identityNullifier;

    // taahhüdün akredite listede olduğunu kanıtla
    component tree = MerkleTreeInclusionProof(nLevels);
    tree.leaf <== commitmentHasher.out;
    for (var i = 0; i < nLevels; i++) {
        tree.pathIndices[i] <== pathIndices[i];
        tree.siblings[i] <== siblings[i];
    }
    root <== tree.root;

    // nullifier: kapsam başına tek kullanım
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== externalNullifier;
    nullifierHasher.inputs[1] <== identityNullifier;
    nullifierHash <== nullifierHasher.out;

    // signalHash'i devreye dahil et: kanıt başka bir cüzdana taşınamaz
    signal signalHashSquared;
    signalHashSquared <== signalHash * signalHash;
}

component main {public [externalNullifier, signalHash]} = ResearcherIdentity(20);
