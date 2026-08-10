// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {IGroth16Verifier} from "../interfaces/IGroth16Verifier.sol";

/**
 * @title  AllowAllVerifier
 * @notice YALNIZCA TEST ICIN. Her kaniti gecerli sayar.
 * @dev Uretimde asla deploy edilmemeli — snarkjs Groth16Verifier kullanilir.
 */
contract AllowAllVerifier is IGroth16Verifier {
    function verifyProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256[4] calldata
    ) external pure returns (bool) {
        return true;
    }
}
