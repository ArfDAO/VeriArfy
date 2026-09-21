// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

contract ClinicalProtocolHarness {
    mapping(address participant => bool) public enrolled;
    mapping(address participant => bool) public inPool;

    function setParticipant(address participant, bool enrolled_, bool inPool_) external {
        enrolled[participant] = enrolled_;
        inPool[participant] = inPool_;
    }

    function isEnrolled(address participant) external view returns (bool) {
        return enrolled[participant];
    }

    function wasInPoolAt(address participant, uint256) external view returns (bool) {
        return inPool[participant];
    }
}

contract ClinicalRegistryHarness {
    mapping(address researcher => bool) public registered;

    function setRegistered(address researcher, bool registered_) external {
        registered[researcher] = registered_;
    }

    function isRegistered(address researcher) external view returns (bool) {
        return registered[researcher];
    }
}
