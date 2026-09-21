// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {VeriarfyProtocol} from "./VeriarfyProtocol.sol";

/// @notice Synthetic-only E/18 deployment profile with disclosure gates active at genesis.
/// @dev Not a real-human genomic privacy guarantee. Never deploy with real-person data.
contract VeriarfyProtocolE18 is VeriarfyProtocol {
    constructor(
        address initialOwner,
        uint256 threshold,
        address provenanceVerifier,
        uint256 initialAccreditedRoot
    ) VeriarfyProtocol(initialOwner, threshold, 60, provenanceVerifier, initialAccreditedRoot) {
        e18DisclosurePolicyActive = true;
    }
}
