// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

/**
 * @title IGroth16Verifier
 * @notice snarkjs tarafindan uretilen Groth16Verifier kontratinin arayuzu.
 * @dev Public sinyal sirasi devre ile sabittir:
 *      [0] root, [1] nullifierHash, [2] externalNullifier, [3] signalHash
 */
interface IGroth16Verifier {
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[4] calldata pubSignals
    ) external view returns (bool);
}
