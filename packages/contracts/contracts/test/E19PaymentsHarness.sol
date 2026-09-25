// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

/** @dev Focused payment tests do not need an FHE bypass; they only model public E/19 accounting views. */
contract E19PaymentsProtocolHarness {
    error NotGateway(address caller);
    error AlreadyRequested();

    address public gateway;
    uint32 public participantCount;
    mapping(address participant => uint32) public participantIndex;
    address private _researcher;
    uint32 private _snapshotCount;
    uint256 private _approvals;
    bool private _granted;
    bool private _requested;

    function setGateway(address gateway_) external { gateway = gateway_; }
    function setParticipantCount(uint32 count) external { participantCount = count; }
    function setParticipant(address participant, uint32 index) external { participantIndex[participant] = index; }
    function setGranted(bool granted_) external { _granted = granted_; }
    function setApprovals(uint256 approvals_) external { _approvals = approvals_; }

    function requestAggregate(address researcher) external {
        if (msg.sender != gateway) revert NotGateway(msg.sender);
        if (_requested) revert AlreadyRequested();
        _requested = true;
        _researcher = researcher;
        _snapshotCount = participantCount;
    }

    function aggregateRequest() external view returns (address researcher, uint32 snapshotCount, uint256 approvals, bool granted) {
        return (_researcher, _snapshotCount, _approvals, _granted);
    }
}

contract E19PaymentsAggregateHarness {
    uint32 public endpointCount;
    mapping(uint32 endpoint => uint32) public responseCoverageCount;
    mapping(address participant => bool) public contributed;

    function setEndpointCount(uint32 count) external { endpointCount = count; }
    function setCoverage(uint32 endpoint, uint32 coverage) external { responseCoverageCount[endpoint] = coverage; }
    function setContributed(address participant, bool value) external { contributed[participant] = value; }
}

contract E19PaymentsRegistryHarness {
    mapping(address researcher => bool) public registered;
    function setRegistered(address researcher, bool value) external { registered[researcher] = value; }
    function isRegistered(address researcher) external view returns (bool) { return registered[researcher]; }
}
