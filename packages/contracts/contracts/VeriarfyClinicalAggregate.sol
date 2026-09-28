// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, ebool, euint8, euint32, externalEuint8} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ClinicalResponseStats} from "./libraries/ClinicalResponseStats.sol";

interface IClinicalEligibility {
    function isEligibleContributor(address participant) external view returns (bool);
    function requireAuthorizedResearcher(address researcher, bytes32 panelId, bytes32 purposeId) external view;
}

interface IClinicalGroupProtocol {
    function participantGroup(address participant) external view returns (euint8);
}

/// @notice Synthetic-only encrypted pharmacogenomic response aggregate for E/19.
contract VeriarfyClinicalAggregate is ZamaEthereumConfig, Ownable, ReentrancyGuard {
    error NotProtocol(address caller);
    error NotEligible(address participant);
    error EmptyPanel();
    error PanelFrozen();
    error InvalidEndpoint(uint32 endpoint);
    error InvalidResponseBatch(uint32 requested, uint32 expected);
    error AlreadyContributed(address participant);
    error SnapshotMissing(uint256 requestId);

    event ClinicalEndpointsConfigured(uint32 endpointCount, bytes32 panelHash, string panelUri);
    event ClinicalResponseContributed(address indexed participant, uint32 endpointCount);
    event ClinicalSnapshotTaken(uint256 indexed requestId, address indexed researcher);

    IClinicalGroupProtocol public immutable protocol;
    IClinicalEligibility public immutable consent;
    bytes32 public immutable panelId;
    bytes32 public immutable purposeId;
    bytes32[] private _endpoints;
    bytes32 public endpointsHash;
    string public endpointsUri;
    bool public panelFrozen;
    mapping(address participant => bool) public contributed;
    mapping(uint32 endpoint => uint32) public responseCoverageCount;
    mapping(uint32 endpoint => euint32[2][2]) private _live;
    mapping(uint256 requestId => mapping(uint32 endpoint => euint32[2][2])) private _frozen;
    mapping(uint256 requestId => mapping(uint32 endpoint => euint32[2][2])) private _released;
    mapping(uint256 requestId => bool) private _snapshotted;
    mapping(uint32 endpoint => bool) private _initialized;

    modifier onlyProtocol() {
        if (msg.sender != address(protocol)) revert NotProtocol(msg.sender);
        _;
    }

    constructor(address protocol_, address consent_, bytes32 panelId_, bytes32 purposeId_) Ownable(msg.sender) {
        if (protocol_ == address(0) || consent_ == address(0) || panelId_ == bytes32(0) || purposeId_ == bytes32(0)) revert EmptyPanel();
        protocol = IClinicalGroupProtocol(protocol_);
        consent = IClinicalEligibility(consent_);
        panelId = panelId_;
        purposeId = purposeId_;
    }

    function configureEndpoints(bytes32[] calldata endpoints, bytes32 endpointsHash_, string calldata endpointsUri_) external onlyOwner {
        if (panelFrozen) revert PanelFrozen();
        if (endpoints.length == 0 || endpointsHash_ == bytes32(0)) revert EmptyPanel();
        delete _endpoints;
        for (uint32 i = 0; i < endpoints.length; ++i) {
            if (endpoints[i] == bytes32(0)) revert InvalidEndpoint(i);
            _endpoints.push(endpoints[i]);
        }
        endpointsHash = endpointsHash_;
        endpointsUri = endpointsUri_;
        emit ClinicalEndpointsConfigured(uint32(endpoints.length), endpointsHash_, endpointsUri_);
    }

    function endpointCount() external view returns (uint32) { return uint32(_endpoints.length); }
    function endpointAt(uint32 endpoint) external view returns (bytes32) {
        if (endpoint >= _endpoints.length) revert InvalidEndpoint(endpoint);
        return _endpoints[endpoint];
    }

    /// @notice Each response is encrypted binary (0/1); a caller contributes the complete fixed panel once.
    function contributeResponses(externalEuint8[] calldata encryptedResponses, bytes calldata inputProof) external nonReentrant {
        uint32 count = uint32(_endpoints.length);
        if (encryptedResponses.length != count) revert InvalidResponseBatch(uint32(encryptedResponses.length), count);
        if (!consent.isEligibleContributor(msg.sender)) revert NotEligible(msg.sender);
        if (contributed[msg.sender]) revert AlreadyContributed(msg.sender);
        panelFrozen = true;
        euint8 group = protocol.participantGroup(msg.sender);
        ebool inControl = FHE.eq(group, 0);
        ebool inCase = FHE.eq(group, 1);
        for (uint32 endpoint = 0; endpoint < count; ++endpoint) {
            if (!_initialized[endpoint]) {
                ClinicalResponseStats.initialize(_live, endpoint);
                _initialized[endpoint] = true;
            }
            euint8 response = FHE.min(FHE.fromExternal(encryptedResponses[endpoint], inputProof), FHE.asEuint8(1));
            ClinicalResponseStats.accumulate(_live, endpoint, response, inControl, inCase);
            responseCoverageCount[endpoint] += 1;
        }
        contributed[msg.sender] = true;
        emit ClinicalResponseContributed(msg.sender, count);
    }

    function snapshotFor(uint256 requestId, address researcher) external onlyProtocol {
        consent.requireAuthorizedResearcher(researcher, panelId, purposeId);
        uint32 count = uint32(_endpoints.length);
        for (uint32 endpoint = 0; endpoint < count; ++endpoint) {
            ClinicalResponseStats.snapshot(_live, _frozen[requestId], endpoint);
        }
        _snapshotted[requestId] = true;
        emit ClinicalSnapshotTaken(requestId, researcher);
    }

    function grantSafeFor(uint256 requestId, address researcher) external onlyProtocol {
        if (!_snapshotted[requestId]) revert SnapshotMissing(requestId);
        uint32 count = uint32(_endpoints.length);
        for (uint32 endpoint = 0; endpoint < count; ++endpoint) {
            ClinicalResponseStats.grantSafe(_frozen[requestId], _released[requestId], endpoint, researcher);
        }
    }

    function responseAggregate(uint32 endpoint, uint8 group, uint8 response) external view returns (euint32) {
        if (endpoint >= _endpoints.length || group > 1 || response > 1) revert InvalidEndpoint(endpoint);
        return _live[endpoint][group][response];
    }

    function disclosureResponseAt(uint256 requestId, uint32 endpoint, uint8 group, uint8 response) external view returns (euint32) {
        if (!_snapshotted[requestId] || endpoint >= _endpoints.length || group > 1 || response > 1) revert InvalidEndpoint(endpoint);
        return _released[requestId][endpoint][group][response];
    }
}
