// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, euint8, externalEuint8} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IVeriarfyClinicalE19Module {
    function snapshotFor(uint256 requestId, address researcher) external;
    function grantSafeFor(uint256 requestId, address researcher) external;
}

/// @notice Synthetic-only E/19 protocol profile. It is separate from frozen E/18 deployments.
contract VeriarfyProtocolE19 is ZamaEthereumConfig, Ownable, ReentrancyGuard {
    error ZeroAddress();
    error ModuleAlreadyLocked();
    error ModuleMissing();
    error AlreadyEnrolled(address participant);
    error NotParticipant(address participant);
    error AlreadyLeft(address participant);
    error NotQueryGateway(address caller);
    error NotAuthorizedNode(address caller);
    error ThresholdNotMet(uint256 approvals, uint256 required);
    error NotEnoughParticipants(uint32 available, uint32 required);
    error E19AlreadyRequested();

    event ClinicalModuleUpdated(address indexed module);
    event QueryGatewayUpdated(address indexed gateway);
    event NodeAuthorized(address indexed node);
    event Enrolled(address indexed participant, uint32 indexed participantIndex);
    event LeftPool(address indexed participant, uint256 indexed blockNumber);
    event AggregateRequested(uint256 indexed requestId, address indexed researcher, uint32 snapshotCount);
    event AggregateApproved(uint256 indexed requestId, address indexed node, uint256 approvals);
    event AggregateGranted(uint256 indexed requestId, address indexed researcher);

    uint8 public constant GROUP_CONTROL = 0;
    uint8 public constant GROUP_CASE = 1;
    uint32 public constant MIN_PARTICIPANTS = 60;

    address public clinicalModule;
    address public queryGateway;
    uint256 public immutable approvalThreshold;
    uint32 public participantCount;
    mapping(address participant => euint8) private _participantGroup;
    mapping(address participant => bool) public isEnrolled;
    mapping(address participant => uint32) public participantIndex;
    mapping(address participant => uint256) public leftPoolAtBlock;
    mapping(address node => bool) public authorizedNode;

    struct AggregateRequest { address researcher; uint32 snapshotCount; uint256 approvals; bool granted; }
    AggregateRequest private _request;
    bool public requested;
    mapping(address node => bool) private _approved;

    constructor(address initialOwner, uint256 approvalThreshold_) Ownable(initialOwner) {
        if (initialOwner == address(0) || approvalThreshold_ == 0) revert ZeroAddress();
        approvalThreshold = approvalThreshold_;
    }

    function setClinicalModule(address module) external onlyOwner {
        if (clinicalModule != address(0)) revert ModuleAlreadyLocked();
        if (module == address(0)) revert ZeroAddress();
        if (participantCount != 0) revert ModuleAlreadyLocked();
        clinicalModule = module;
        emit ClinicalModuleUpdated(module);
    }

    function setQueryGateway(address gateway) external onlyOwner {
        if (gateway == address(0)) revert ZeroAddress();
        queryGateway = gateway;
        emit QueryGatewayUpdated(gateway);
    }

    function authorizeNode(address node) external onlyOwner {
        if (node == address(0)) revert ZeroAddress();
        authorizedNode[node] = true;
        emit NodeAuthorized(node);
    }

    function enroll(externalEuint8 encGroup, bytes calldata inputProof) external nonReentrant {
        if (clinicalModule == address(0)) revert ModuleMissing();
        if (isEnrolled[msg.sender]) revert AlreadyEnrolled(msg.sender);
        euint8 group = FHE.min(FHE.fromExternal(encGroup, inputProof), FHE.asEuint8(GROUP_CASE));
        _participantGroup[msg.sender] = group;
        FHE.allowThis(group);
        FHE.allow(group, clinicalModule);
        isEnrolled[msg.sender] = true;
        participantCount += 1;
        participantIndex[msg.sender] = participantCount;
        emit Enrolled(msg.sender, participantCount);
    }

    function participantGroup(address participant) external view returns (euint8) { return _participantGroup[participant]; }

    function leavePool() external {
        if (participantIndex[msg.sender] == 0) revert NotParticipant(msg.sender);
        if (leftPoolAtBlock[msg.sender] != 0) revert AlreadyLeft(msg.sender);
        leftPoolAtBlock[msg.sender] = block.number;
        emit LeftPool(msg.sender, block.number);
    }

    function wasInPoolAt(address participant, uint256 blockNumber) external view returns (bool) {
        if (participantIndex[participant] == 0) return false;
        uint256 left = leftPoolAtBlock[participant];
        return left == 0 || blockNumber < left;
    }

    function requestAggregate(address researcher) external {
        if (msg.sender != queryGateway) revert NotQueryGateway(msg.sender);
        if (requested) revert E19AlreadyRequested();
        if (participantCount < MIN_PARTICIPANTS) revert NotEnoughParticipants(participantCount, MIN_PARTICIPANTS);
        requested = true;
        _request = AggregateRequest({researcher: researcher, snapshotCount: participantCount, approvals: 0, granted: false});
        IVeriarfyClinicalE19Module(clinicalModule).snapshotFor(0, researcher);
        emit AggregateRequested(0, researcher, participantCount);
    }

    function approveAggregate(uint256 requestId) external {
        if (requestId != 0 || !requested) revert E19AlreadyRequested();
        if (!authorizedNode[msg.sender]) revert NotAuthorizedNode(msg.sender);
        if (!_approved[msg.sender]) { _approved[msg.sender] = true; _request.approvals += 1; }
        emit AggregateApproved(0, msg.sender, _request.approvals);
    }

    function executeAggregate(uint256 requestId) external nonReentrant {
        if (requestId != 0 || !requested || _request.granted) revert E19AlreadyRequested();
        if (_request.approvals < approvalThreshold) revert ThresholdNotMet(_request.approvals, approvalThreshold);
        _request.granted = true;
        IVeriarfyClinicalE19Module(clinicalModule).grantSafeFor(0, _request.researcher);
        emit AggregateGranted(0, _request.researcher);
    }

    function aggregateRequest() external view returns (AggregateRequest memory) { return _request; }
}
