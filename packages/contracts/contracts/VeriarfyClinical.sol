// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IVeriarfyClinicalProtocol {
    function isEnrolled(address participant) external view returns (bool);

    function wasInPoolAt(address participant, uint256 blockNumber) external view returns (bool);
}

interface IVeriarfyClinicalRegistry {
    function isRegistered(address researcher) external view returns (bool);
}

/// @notice Consent and access-policy boundary for a single clinical/pharmacogenomic panel.
/// @dev This contract never stores clinical values, identities, or consent text. It stores only
///      versioned commitments and permits future aggregate-only modules to check eligibility.
contract VeriarfyClinical is Ownable {
    error ZeroAddress();
    error PolicyNotConfigured();
    error PolicyFrozen();
    error InvalidPolicy();
    error NotEnrolled(address participant);
    error ConsentScopeMismatch();
    error InvalidConsentExpiry(uint64 expiresAt, uint64 nowTime, uint64 maximum);
    error ConsentNotActive(address participant);
    error ResearcherNotRegistered(address researcher);
    error ResearchPurposeMismatch();

    event ClinicalPolicyConfigured(
        bytes32 indexed panelId,
        bytes32 indexed purposeId,
        bytes32 indexed consentVersion,
        bytes32 panelHash,
        bytes32 consentDocumentHash,
        uint64 maxConsentDuration,
        string panelUri
    );
    event ClinicalConsentAccepted(
        address indexed participant,
        bytes32 indexed panelId,
        bytes32 indexed consentVersion,
        uint64 acceptedAt,
        uint64 expiresAt
    );
    event ClinicalConsentRevoked(address indexed participant, uint64 revokedAt);

    struct ClinicalPolicy {
        bytes32 panelId;
        bytes32 purposeId;
        bytes32 consentVersion;
        bytes32 panelHash;
        bytes32 consentDocumentHash;
        uint64 maxConsentDuration;
        string panelUri;
    }

    struct Consent {
        uint64 acceptedAt;
        uint64 expiresAt;
        uint64 revokedAt;
    }

    IVeriarfyClinicalProtocol public immutable protocol;
    IVeriarfyClinicalRegistry public immutable researcherRegistry;

    ClinicalPolicy private _policy;
    bool public policyConfigured;
    bool public policyFrozen;
    mapping(address participant => Consent) private _consents;

    constructor(address protocol_, address researcherRegistry_) Ownable(msg.sender) {
        if (protocol_ == address(0) || researcherRegistry_ == address(0)) revert ZeroAddress();
        protocol = IVeriarfyClinicalProtocol(protocol_);
        researcherRegistry = IVeriarfyClinicalRegistry(researcherRegistry_);
    }

    /// @notice Sets the only panel/purpose/consent version accepted by this deployment.
    /// @dev The policy freezes on the first accepted consent. Changed medical scope requires a
    ///      separately deployed module rather than silently repurposing existing consent.
    function configurePolicy(ClinicalPolicy calldata policy_) external onlyOwner {
        if (policyFrozen) revert PolicyFrozen();
        if (
            policy_.panelId == bytes32(0) ||
            policy_.purposeId == bytes32(0) ||
            policy_.consentVersion == bytes32(0) ||
            policy_.panelHash == bytes32(0) ||
            policy_.consentDocumentHash == bytes32(0) ||
            policy_.maxConsentDuration == 0
        ) revert InvalidPolicy();

        _policy = policy_;
        policyConfigured = true;
        emit ClinicalPolicyConfigured(
            policy_.panelId,
            policy_.purposeId,
            policy_.consentVersion,
            policy_.panelHash,
            policy_.consentDocumentHash,
            policy_.maxConsentDuration,
            policy_.panelUri
        );
    }

    function policy() external view returns (ClinicalPolicy memory) {
        return _policy;
    }

    /// @notice Records explicit consent to the exact configured scope.
    /// @dev The participant must already be enrolled. Expiry is bounded so an accidental or
    ///      malicious client cannot create an effectively permanent consent record.
    function acceptConsent(
        bytes32 panelId,
        bytes32 purposeId,
        bytes32 consentVersion,
        bytes32 consentDocumentHash,
        uint64 expiresAt
    ) external {
        if (!policyConfigured) revert PolicyNotConfigured();
        if (!protocol.isEnrolled(msg.sender)) revert NotEnrolled(msg.sender);
        ClinicalPolicy storage configured = _policy;
        if (
            panelId != configured.panelId ||
            purposeId != configured.purposeId ||
            consentVersion != configured.consentVersion ||
            consentDocumentHash != configured.consentDocumentHash
        ) revert ConsentScopeMismatch();

        uint64 nowTime = uint64(block.timestamp);
        uint64 maximum = nowTime + configured.maxConsentDuration;
        if (expiresAt <= nowTime || expiresAt > maximum) {
            revert InvalidConsentExpiry(expiresAt, nowTime, maximum);
        }

        _consents[msg.sender] = Consent({acceptedAt: nowTime, expiresAt: expiresAt, revokedAt: 0});
        policyFrozen = true;
        emit ClinicalConsentAccepted(msg.sender, panelId, consentVersion, nowTime, expiresAt);
    }

    /// @notice Stops future clinical contributions by the caller.
    /// @dev Past aggregate snapshots cannot be retroactively subtracted; callers must present
    ///      that irreversibility before collecting consent.
    function revokeConsent() external {
        Consent storage consent = _consents[msg.sender];
        if (!_isActive(consent, uint64(block.timestamp))) revert ConsentNotActive(msg.sender);
        consent.revokedAt = uint64(block.timestamp);
        emit ClinicalConsentRevoked(msg.sender, consent.revokedAt);
    }

    function consentOf(address participant) external view returns (Consent memory) {
        return _consents[participant];
    }

    /// @notice Eligibility gate for a future clinical contribution module.
    /// @dev A revoked/expired consent blocks future use, while prior aggregate snapshots remain
    ///      immutable by design and are not represented as current eligibility.
    function isEligibleContributor(address participant) external view returns (bool) {
        return protocol.isEnrolled(participant) &&
            protocol.wasInPoolAt(participant, block.number) &&
            _isActive(_consents[participant], uint64(block.timestamp));
    }

    /// @notice Aggregate-only research requests must name the configured panel and purpose and
    ///         originate from the existing on-chain researcher registry.
    function requireAuthorizedResearcher(
        address researcher,
        bytes32 panelId,
        bytes32 purposeId
    ) external view {
        if (!policyConfigured) revert PolicyNotConfigured();
        if (!researcherRegistry.isRegistered(researcher)) revert ResearcherNotRegistered(researcher);
        if (panelId != _policy.panelId || purposeId != _policy.purposeId) {
            revert ResearchPurposeMismatch();
        }
    }

    function isAuthorizedResearcher(
        address researcher,
        bytes32 panelId,
        bytes32 purposeId
    ) external view returns (bool) {
        return policyConfigured &&
            researcherRegistry.isRegistered(researcher) &&
            panelId == _policy.panelId &&
            purposeId == _policy.purposeId;
    }

    function _isActive(Consent storage consent, uint64 nowTime) private view returns (bool) {
        return consent.acceptedAt != 0 && consent.revokedAt == 0 && nowTime < consent.expiresAt;
    }
}
