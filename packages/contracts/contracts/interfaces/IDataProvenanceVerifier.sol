// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

/**
 * @title IDataProvenanceVerifier
 * @notice snarkjs tarafindan uretilen DataProvenanceVerifier kontratinin arayuzu.
 *
 * @dev Public sinyal sirasi devre tarafindan SABITLENIR
 *      (`data_provenance.circom`, `component main`):
 *
 *        [0] root              akredite kurumlar agacinin koku
 *        [1] nullifierHash     Poseidon(externalNullifier, commitment)
 *        [2] commitment        Poseidon(paketlenmis panel, salt)
 *        [3] externalNullifier kapsam ayraci
 *        [4] cidHigh           CID digest'inin ust 128 biti
 *        [5] cidLow            CID digest'inin alt 128 biti
 *        [6] signalHash        uint256(uint160(yukleyen))
 *
 *      Circom'da CIKTILAR once, sonra acik GIRDILER bildirim sirasiyla gelir.
 *      Bu sira degisirse kontrat sessizce yanlis alanlari karsilastirir —
 *      derleyici uyarmaz. Devre degistirilirse burasi da guncellenmelidir.
 */
interface IDataProvenanceVerifier {
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        // 12 sinyal: [root, nullifierHash, commitment, coverage[0..4],
        //             externalNullifier, cidHigh, cidLow, signalHash]
        // Kapsama kelimeleri devrenin ciktisidir; sayilari PANEL/240 ile
        // belirlenir (PANEL=1000 -> 5).
        uint256[13] calldata pubSignals
    ) external view returns (bool);
}
