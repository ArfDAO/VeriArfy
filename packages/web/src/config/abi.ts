// Frontend'in ihtiyac duydugu minimal ABI parcalari.

export const REGISTRY_ABI = [
  "function isRegistered(address) view returns (bool)",
  "function researcherCount() view returns (uint256)",
  "function currentRoot() view returns (uint256)",
  "function register(uint256 root, uint256 nullifierHash, uint256[2] pA, uint256[2][2] pB, uint256[2] pC)",
  "event ResearcherRegistered(address indexed account, uint256 indexed nullifierHash)",
] as const;

/**
 * VeriarfyProtocol — sifreli havuz, IPFS indeksi ve Gizlilik Paneli izinleri.
 *
 * `permission(...)` bir struct dondurur; ethers'in tuple sozdizimi kullanilir.
 * Alan sirasi kontrattaki `Permission` yapisiyla BIREBIR ayni olmalidir —
 * sira kayarsa hata olusmaz, yanlis alan okunur.
 */
export const PROTOCOL_ABI = [
  "function participantCount() view returns (uint32)",
  "function recordCount() view returns (uint32)",
  "function participantIndex(address) view returns (uint32)",
  "function userCIDs(address) view returns (bytes32)",
  "function panelCommitment(address) view returns (uint256)",
  "function hasAggregated(address) view returns (bool)",
  "function consentCount(address) view returns (uint32)",
  "function minParticipants() view returns (uint32)",
  "function QUERY_TYPE_GWAS() view returns (uint8)",
  "function QUERY_TYPE_ML() view returns (uint8)",
  "function QUERY_TYPE_STATISTICS() view returns (uint8)",
  // GWAS — sifreli kontenjans tablosu. Donen handle'lar sifrelidir; cozmek
  // esikli onaya baglidir. Panel yalnizca "tablo hazir mi" bilgisini gosterir.
  "function GROUP_CONTROL() view returns (uint8)",
  "function GROUP_CASE() view returns (uint8)",
  "function DOSAGE_LEVELS() view returns (uint8)",
  "function contingencyTable() view returns (uint256[3][2])",
  // BSKK-44 — rapor §2.6: esik sorgu hassasiyetine gore degisir.
  "function requiredApprovals(uint8 queryType) view returns (uint32)",
  "function isDisclosureGranted(uint256 requestId) view returns (bool)",
  "function authorizedNodeCount() view returns (uint256)",
  "function aggregateDosage(bytes32 encGroup, bytes32 encDosage, bytes inputProof)",
  "event DosageAggregated(address indexed participant, uint32 participantCount)",
  "function permission(address participant, address researcher) view returns (tuple(bool isAllowed, uint8 queryTypes, uint256 grantedAtBlock, uint256 revokedAtBlock, uint256 expirationBlock, uint256 maxQueries))",
  "function grantAccess(address researcher, uint8 queryTypes, uint256 expirationBlock, uint256 maxQueries)",
  "function revokeAccess(address researcher)",
  "event AccessGranted(address indexed participant, address indexed researcher, uint8 queryTypes, uint256 expirationBlock)",
  "event AccessRevoked(address indexed participant, address indexed researcher, uint256 atBlock)",
  "event RecordSubmitted(address indexed participant, bytes32 indexed cidDigest, bool replaced)",
] as const;

/** VeriarfyPayments — hesaplama basina odeme ve gelir paylasimi. */
export const PAYMENTS_ABI = [
  "function nextQueryId() view returns (uint256)",
  "function treasuryBalance() view returns (uint256)",
  "function liquidityShareBps() view returns (uint16)",
  "function baseFee() view returns (uint256)",
  "function perParticipantFee() view returns (uint256)",
  "function quoteFor(address researcher) view returns (uint256 fee, uint32 participants)",
  "function claimable(uint256 queryId, address account) view returns (uint256)",
  "function pendingRewards(address account) view returns (uint256 total, uint256[] queryIds)",
  "function hasClaimed(uint256 queryId, address account) view returns (bool)",
  "function query(uint256 queryId) view returns (address researcher, uint256 fee, uint256 liquidityPot, uint32 snapshotCount, uint256 openedAtBlock, uint256 claimedTotal, uint256 disclosureRequestId, bool settled, bool refunded)",
  "function claim(uint256 queryId) returns (uint256)",
  "function REFUND_DELAY() view returns (uint256)",
  "event QuerySettled(uint256 indexed queryId, uint256 liquidityPot, uint256 treasuryShare)",
  "event QueryOpened(uint256 indexed queryId, address indexed researcher, uint256 fee, uint256 disclosureRequestId, uint32 snapshotCount)",
  "event RewardClaimed(uint256 indexed queryId, address indexed participant, uint256 amount)",
] as const;

/** Odeme token'i — panelde bakiye ve ondalik gostermek icin. */
export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
] as const;

export const STUDY_ABI = [
  "function participantCount() view returns (uint32)",
  "function hasSubmitted(address) view returns (bool)",
  "function submit(bytes32 encGroup, bytes32 encAnxiety, bytes32 encPanic, bytes inputProof)",
  "function anxietyAggregate(uint8 group) view returns (bytes32 n, bytes32 sum, bytes32 sumSq)",
  "function panicAggregate(uint8 group) view returns (bytes32 n, bytes32 sum, bytes32 sumSq)",
  "event ResponseSubmitted(address indexed participant, uint32 participantIndex)",
] as const;
