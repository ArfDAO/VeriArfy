// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IE19PaymentProtocol {
    function participantCount() external view returns (uint32);
    function participantIndex(address participant) external view returns (uint32);
    function requestAggregate(address researcher) external;
    function aggregateRequest()
        external
        view
        returns (address researcher, uint32 snapshotCount, uint256 approvals, bool granted);
}

interface IE19PaymentAggregate {
    function endpointCount() external view returns (uint32);
    function responseCoverageCount(uint32 endpoint) external view returns (uint32);
    function contributed(address participant) external view returns (bool);
}

interface IE19PaymentRegistry {
    function isRegistered(address account) external view returns (bool);
}

/**
 * @title VeriarfyE19Payments
 * @notice E/19'un sabit klinik paneli icin ayri odeme ve hak edis adaptoru.
 *
 * E/19'un tek ve immutable aggregate talebi vardir. Bu kontrat da bilerek
 * tek sorgu acabilir: sonraki bir "sorgu" icin yeni bir E/19 deployment'i
 * gerekir. E/18'in genel odeme sozlesmesine baglanmaz; boylece donmus E/18
 * politikasi ve ekonomisi degismez.
 *
 * Her klinik katki sabit panelin tum endpoint'lerini bir kez gonderir.
 * Bu nedenle alan-bazli sayaclar/sikliklar yine dondurulur ve denetlenir,
 * fakat bu profile'da katki yapan herkes ayni tam endpoint setini kapsar.
 * Eksik endpoint beyanli ya da secmeli klinik odul iddiasi yapilmaz.
 */
contract VeriarfyE19Payments is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint32 public constant BPS_DENOMINATOR = 10_000;

    error ZeroAddress();
    error NotRegisteredResearcher(address caller);
    error QueryAlreadyOpened();
    error QueryMissing();
    error NoCoveredFields();
    error InvalidEndpoint(uint32 endpoint);
    error InvalidShare(uint16 share);
    error InvalidScarcityCap(uint32 cap);
    error OutputNotGranted();
    error AlreadySettled();
    error NotSettled();
    error AlreadyClaimed(address participant);
    error NotContributor(address participant);
    error NotInSnapshot(address participant);
    error NothingToWithdraw();
    error QueryResearcherMismatch(address expected, address actual);

    event PricingUpdated(uint256 baseFee, uint256 perRecordFee);
    event LiquidityShareUpdated(uint16 liquidityShareBps);
    event ScarcityCapUpdated(uint32 maxScarcityBps);
    event QueryOpened(uint256 indexed queryId, address indexed researcher, uint256 fee, uint32 snapshotCount);
    event QuerySettled(uint256 indexed queryId, uint256 liquidityPot, uint256 treasuryShare);
    event RewardClaimed(uint256 indexed queryId, address indexed participant, uint256 amount);
    event TreasuryWithdrawn(address indexed to, uint256 amount);

    struct Query {
        address researcher;
        uint256 fee;
        uint256 liquidityPot;
        uint32 snapshotCount;
        uint256 openedAtBlock;
        uint256 coverageTotal;
        uint256 weightedTotal;
        uint256 claimedTotal;
        bool settled;
    }

    IE19PaymentProtocol public immutable protocol;
    IE19PaymentAggregate public immutable aggregate;
    IE19PaymentRegistry public immutable researchers;
    IERC20 public immutable token;

    uint256 public baseFee;
    uint256 public perRecordFee;
    uint16 public liquidityShareBps;
    uint32 public maxScarcityBps;
    uint256 public treasuryBalance;
    bool public opened;
    Query private _query;

    /// @notice Endpoint basina sorgu acildigi andaki kapsama ve kitlik.
    mapping(uint32 endpoint => uint32) public queryFieldCoverage;
    mapping(uint32 endpoint => uint32) public queryFieldScarcityBps;
    mapping(address participant => bool) public hasClaimed;

    constructor(
        address initialOwner,
        address protocol_,
        address aggregate_,
        address token_,
        address researchers_,
        uint256 baseFee_,
        uint256 perRecordFee_,
        uint16 liquidityShareBps_,
        uint32 maxScarcityBps_
    ) Ownable(initialOwner) {
        if (
            initialOwner == address(0) || protocol_ == address(0) || aggregate_ == address(0) ||
            token_ == address(0) || researchers_ == address(0)
        ) revert ZeroAddress();
        if (liquidityShareBps_ > BPS_DENOMINATOR) revert InvalidShare(liquidityShareBps_);
        if (maxScarcityBps_ < BPS_DENOMINATOR) revert InvalidScarcityCap(maxScarcityBps_);

        protocol = IE19PaymentProtocol(protocol_);
        aggregate = IE19PaymentAggregate(aggregate_);
        token = IERC20(token_);
        researchers = IE19PaymentRegistry(researchers_);
        baseFee = baseFee_;
        perRecordFee = perRecordFee_;
        liquidityShareBps = liquidityShareBps_;
        maxScarcityBps = maxScarcityBps_;
    }

    function setPricing(uint256 baseFee_, uint256 perRecordFee_) external onlyOwner {
        baseFee = baseFee_;
        perRecordFee = perRecordFee_;
        emit PricingUpdated(baseFee_, perRecordFee_);
    }

    function setLiquidityShare(uint16 liquidityShareBps_) external onlyOwner {
        if (liquidityShareBps_ > BPS_DENOMINATOR) revert InvalidShare(liquidityShareBps_);
        liquidityShareBps = liquidityShareBps_;
        emit LiquidityShareUpdated(liquidityShareBps_);
    }

    function setScarcityCap(uint32 maxScarcityBps_) external onlyOwner {
        if (maxScarcityBps_ < BPS_DENOMINATOR) revert InvalidScarcityCap(maxScarcityBps_);
        maxScarcityBps = maxScarcityBps_;
        emit ScarcityCapUpdated(maxScarcityBps_);
    }

    /// @notice Sabit panelin mevcut kapsamasina gore tahmini ucret.
    function quote() external view returns (uint256 fee, uint256 records, uint256 weightedRecords) {
        return _quote(protocol.participantCount());
    }

    /// @notice Bir endpoint'in mevcut zincir-fiyatini denetim icin dondurulmadan gosterir.
    function quoteEndpoint(uint32 endpoint)
        external
        view
        returns (uint32 coverage, uint32 scarcityBps, uint256 price)
    {
        uint32 count = aggregate.endpointCount();
        if (endpoint >= count) revert InvalidEndpoint(endpoint);
        coverage = aggregate.responseCoverageCount(endpoint);
        scarcityBps = _scarcityBps(coverage, protocol.participantCount());
        price = (perRecordFee * coverage * scarcityBps) / BPS_DENOMINATOR;
    }

    /**
     * @notice Emanet ucreti alir ve E/19'un tek aggregate talebini acar.
     *
     * Talep once acilir: klinik modulu arastirmaci kaydini ve sabit amaci
     * kendisi fail-closed dogrular. ERC-20 transferi basarisiz olursa tum
     * islem (talep dahil) atomik olarak geri alinir.
     */
    function openQuery() external nonReentrant returns (uint256 queryId) {
        if (opened) revert QueryAlreadyOpened();
        if (!researchers.isRegistered(msg.sender)) revert NotRegisteredResearcher(msg.sender);

        protocol.requestAggregate(msg.sender);
        (address researcher, uint32 snapshotCount,,) = protocol.aggregateRequest();
        if (researcher != msg.sender) revert QueryResearcherMismatch(msg.sender, researcher);

        (uint256 fee, uint256 coverageTotal, uint256 weightedTotal) = _snapshotPricing(snapshotCount);
        if (coverageTotal == 0 || weightedTotal == 0) revert NoCoveredFields();

        token.safeTransferFrom(msg.sender, address(this), fee);
        opened = true;
        _query = Query({
            researcher: msg.sender,
            fee: fee,
            liquidityPot: 0,
            snapshotCount: snapshotCount,
            openedAtBlock: block.number,
            coverageTotal: coverageTotal,
            weightedTotal: weightedTotal,
            claimedTotal: 0,
            settled: false
        });
        emit QueryOpened(0, msg.sender, fee, snapshotCount);
        return 0;
    }

    /// @notice Sonuc arastirmaciya FHE ACL ile verildikten sonra hakedisleri acar.
    function settleQuery() external nonReentrant {
        if (!opened) revert QueryMissing();
        if (_query.settled) revert AlreadySettled();
        (address researcher,,, bool granted) = protocol.aggregateRequest();
        if (researcher != _query.researcher) revert QueryResearcherMismatch(_query.researcher, researcher);
        if (!granted) revert OutputNotGranted();

        uint256 liquidityPot = (_query.fee * liquidityShareBps) / BPS_DENOMINATOR;
        _query.liquidityPot = liquidityPot;
        _query.settled = true;
        treasuryBalance += _query.fee - liquidityPot;
        emit QuerySettled(0, liquidityPot, _query.fee - liquidityPot);
    }

    function claim() external nonReentrant returns (uint256 amount) {
        if (!opened) revert QueryMissing();
        if (!_query.settled) revert NotSettled();
        if (hasClaimed[msg.sender]) revert AlreadyClaimed(msg.sender);
        if (!aggregate.contributed(msg.sender)) revert NotContributor(msg.sender);
        if (protocol.participantIndex(msg.sender) == 0 || protocol.participantIndex(msg.sender) > _query.snapshotCount) {
            revert NotInSnapshot(msg.sender);
        }

        amount = claimable(msg.sender);
        hasClaimed[msg.sender] = true;
        _query.claimedTotal += amount;
        token.safeTransfer(msg.sender, amount);
        emit RewardClaimed(0, msg.sender, amount);
    }

    function claimable(address participant) public view returns (uint256) {
        if (!opened || !_query.settled || hasClaimed[participant]) return 0;
        if (!aggregate.contributed(participant)) return 0;
        uint32 index = protocol.participantIndex(participant);
        if (index == 0 || index > _query.snapshotCount) return 0;
        return (_query.liquidityPot * _participantWeightedCoverage()) / _query.weightedTotal;
    }

    function query()
        external
        view
        returns (
            address researcher,
            uint256 fee,
            uint256 liquidityPot,
            uint32 snapshotCount,
            uint256 openedAtBlock,
            uint256 coverageTotal,
            uint256 weightedTotal,
            uint256 claimedTotal,
            bool settled
        )
    {
        if (!opened) revert QueryMissing();
        Query storage q = _query;
        return (
            q.researcher, q.fee, q.liquidityPot, q.snapshotCount, q.openedAtBlock,
            q.coverageTotal, q.weightedTotal, q.claimedTotal, q.settled
        );
    }

    function withdrawTreasury(address to) external onlyOwner nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = treasuryBalance;
        if (amount == 0) revert NothingToWithdraw();
        treasuryBalance = 0;
        token.safeTransfer(to, amount);
        emit TreasuryWithdrawn(to, amount);
    }

    function _quote(uint32 pool) private view returns (uint256 fee, uint256 records, uint256 weightedRecords) {
        fee = baseFee;
        uint32 count = aggregate.endpointCount();
        for (uint32 endpoint = 0; endpoint < count; ++endpoint) {
            uint32 coverage = aggregate.responseCoverageCount(endpoint);
            uint32 scarcityBps = _scarcityBps(coverage, pool);
            records += coverage;
            weightedRecords += uint256(coverage) * scarcityBps;
            fee += (perRecordFee * coverage * scarcityBps) / BPS_DENOMINATOR;
        }
    }

    function _snapshotPricing(uint32 pool) private returns (uint256 fee, uint256 coverageTotal, uint256 weightedTotal) {
        fee = baseFee;
        uint32 count = aggregate.endpointCount();
        for (uint32 endpoint = 0; endpoint < count; ++endpoint) {
            uint32 coverage = aggregate.responseCoverageCount(endpoint);
            uint32 scarcityBps = _scarcityBps(coverage, pool);
            queryFieldCoverage[endpoint] = coverage;
            queryFieldScarcityBps[endpoint] = scarcityBps;
            coverageTotal += coverage;
            weightedTotal += uint256(coverage) * scarcityBps;
            fee += (perRecordFee * coverage * scarcityBps) / BPS_DENOMINATOR;
        }
    }

    function _participantWeightedCoverage() private view returns (uint256 weight) {
        uint32 count = aggregate.endpointCount();
        for (uint32 endpoint = 0; endpoint < count; ++endpoint) {
            weight += queryFieldScarcityBps[endpoint];
        }
    }

    function _scarcityBps(uint32 coverage, uint32 pool) private view returns (uint32) {
        if (coverage == 0) return 0;
        uint256 scarcity = (uint256(pool) * BPS_DENOMINATOR) / coverage;
        if (scarcity < BPS_DENOMINATOR) scarcity = BPS_DENOMINATOR;
        if (scarcity > maxScarcityBps) scarcity = maxScarcityBps;
        return uint32(scarcity);
    }
}
