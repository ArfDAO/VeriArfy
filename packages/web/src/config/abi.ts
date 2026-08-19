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
  // Cok SNP'li panel (rapor §3.3). `snpCount` 1 ise davranis eskisiyle ayni.
  "function snpCount() view returns (uint32)",
  "function rareSnpIndex() view returns (uint32)",
  // Panel kimligi — istemcinin hangi varyant listesine hizalandiginin kaniti.
  // Bu olmadan iki kullanicinin "3 numarali SNP"si farkli varyantlar olabilir.
  "function panelHash() view returns (bytes32)",
  "function panelUri() view returns (string)",
  "function DOSAGE_MISSING() view returns (uint8)",
  "function submittedSnps(address) view returns (uint32)",
  "function isEnrolled(address) view returns (bool)",
  "function contingencyTableAt(uint32 snp) view returns (uint256[3][2])",
  "function MAX_DISCLOSURE_WINDOW() view returns (uint32)",
  "function enroll(bytes32 encGroup, bytes inputProof)",
  "function contributeDosages(bytes32[] encDosages, bytes inputProof)",
  "event Enrolled(address indexed participant)",
  "event DosagesContributed(address indexed participant, uint32 fromSnp, uint32 toSnp)",
  // Nadirlik Carpani — rapor §4.3. `isRareCarrier` ancak katilimci
  // `requestRarityAssessment` dedikten ve KMS esigi TEK BITI cozdukten sonra
  // true olabilir; panel bu takasi kullaniciya acikca anlatir.
  "function rarityRequested(address) view returns (bool)",
  "function isRareCarrier(address) view returns (bool)",
  "function rarityConfirmedAtBlock(address) view returns (uint256)",
  "function rarityHandle(address) view returns (bytes32)",
  "function rareCarrierCount() view returns (uint32)",
  "function rarityStats() view returns (uint32 poolCount, uint32 carriers)",
  "function isFoundingContributor(address) view returns (bool)",
  "function FOUNDING_CONTRIBUTOR_LIMIT() view returns (uint32)",
  "function requestRarityAssessment() returns (bytes32)",
  "function confirmRarity(address participant, bytes decryptedResult, bytes decryptionProof)",
  "event RarityAssessmentRequested(address indexed participant, bytes32 handle)",
  "event RarityConfirmed(address indexed participant, bool isRare, uint32 rareCarrierCount)",
  // BSKK-44 — rapor §2.6: esik sorgu hassasiyetine gore degisir.
  "function requiredApprovals(uint8 queryType) view returns (uint32)",
  // Acilim IKI ADIMLIDIR (rapor §2.7.1): esik saglanir (`finalized`), itiraz
  // suresi gecer, sonra yetki fiilen verilir (`granted`). Panel ikisini ayri
  // gosterir; "onaylandi ama henuz teslim edilmedi" gercek bir durumdur.
  "function isDisclosureFinalized(uint256 requestId) view returns (bool)",
  "function isDisclosureGranted(uint256 requestId) view returns (bool)",
  "function isDisclosureRevoked(uint256 requestId) view returns (bool)",
  "function challengeWindowEnd(uint256 requestId) view returns (uint256)",
  "function challengePeriod() view returns (uint256)",
  "function executeDisclosure(uint256 requestId)",
  "function stakingModule() view returns (address)",
  // Dead Man's Switch — rapor §2.6.1. Panel devir durumunu gostermelidir:
  // "yetki su an varis dugumlerde" gorunur bir olgu olmalidir.
  "function isFailoverActive() view returns (bool)",
  "function isHeirNode(address) view returns (bool)",
  "function heirNodeCount() view returns (uint256)",
  "function heirRequiredApprovals(uint8 queryType) view returns (uint32)",
  "function lastMainHeartbeat() view returns (uint256)",
  "function livenessTimeout() view returns (uint256)",
  "function failoverDeclared() view returns (bool)",
  "event FailoverDeclared(uint256 atBlock)",
  "event FailoverCleared(uint256 atBlock)",
  "event Heartbeat(address indexed node, uint256 atBlock)",
  "event DisclosureFinalized(uint256 indexed requestId, uint256 openUntilBlock)",
  "event DisclosureRevokedByChallenge(uint256 indexed requestId)",
  "function authorizedNodeCount() view returns (uint256)",
  "function biomarkerModule() view returns (address)",
  "function aggregateDosage(bytes32 encGroup, bytes32 encDosage, bytes inputProof)",
  "event DosageAggregated(address indexed participant, uint32 participantCount)",
  "function permission(address participant, address researcher) view returns (tuple(bool isAllowed, uint8 queryTypes, uint256 grantedAtBlock, uint256 revokedAtBlock, uint256 expirationBlock, uint256 maxQueries))",
  "function grantAccess(address researcher, uint8 queryTypes, uint256 expirationBlock, uint256 maxQueries)",
  "function revokeAccess(address researcher)",
  "event AccessGranted(address indexed participant, address indexed researcher, uint8 queryTypes, uint256 expirationBlock)",
  "event AccessRevoked(address indexed participant, address indexed researcher, uint256 atBlock)",
  "event RecordSubmitted(address indexed participant, bytes32 indexed cidDigest, bool replaced)",
] as const;

/**
 * VeriarfyBiomarkers — veri kategorisi 2 (surekli olcum kanali).
 *
 * AYRI KONTRAT: girdi kaniti kontrat adresine baglidir, yani olcumler BU
 * adres icin sifrelenir — protokolunki icin degil. Karistirilirsa
 * `fromExternal` gecersiz girdi diye reddeder.
 */
export const BIOMARKERS_ABI = [
  "function metricCount() view returns (uint32)",
  "function metricAt(uint32 index) view returns (tuple(bytes32 code, bytes32 unit, uint32 scale, uint32 offset, uint32 minValue, uint32 maxValue))",
  "function metricsHash() view returns (bytes32)",
  "function metricsUri() view returns (string)",
  "function submittedMetrics(address participant) view returns (uint32)",
  "function hasBiomarkerPanel(address participant) view returns (bool)",
  "function BIOMARKER_MISSING() view returns (uint32)",
  "function MAX_METRIC_VALUE() view returns (uint32)",
  "function contributeBiomarkers(bytes32[] encValues, bytes inputProof)",
  "function biomarkerAggregate(uint32 metric, uint8 group) view returns (bytes32 sum, bytes32 sumSq, bytes32 count)",
  "function disclosureBiomarkerAt(uint256 requestId, uint32 metric, uint8 group) view returns (bytes32 sum, bytes32 sumSq, bytes32 count)",
  "event BiomarkersContributed(address indexed participant, uint32 fromMetric, uint32 toMetric)",
  "event BiomarkerPanelCompleted(address indexed participant)",
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
  // Nadirlik anlik goruntusu — payin nasil hesaplandigini panelde gostermek icin.
  "function weightOf(uint256 queryId, address account) view returns (uint256)",
  "function queryWeights(uint256 queryId) view returns (uint32 poolCount, uint32 carriers, uint256 multiplierBps, uint256 totalWeightBps)",
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

/**
 * VeriarfyStorage — Filecoin kalicilik defteri (rapor §2.9.2).
 *
 * Panel yalnizca OKUR: veri kac saglayicida duruyor, yenileme gerekiyor mu.
 * Anlasma kaydi zincir disi tanigin isidir.
 */
export const STORAGE_ABI = [
  "function currentEpoch() view returns (uint64)",
  "function MIN_REPLICATION() view returns (uint32)",
  "function activeReplicas(bytes32 cidDigest) view returns (uint32)",
  "function isAdequatelyReplicated(bytes32 cidDigest) view returns (bool)",
  "function renewalDue(bytes32 cidDigest) view returns (bool)",
  "function dealCount(bytes32 cidDigest) view returns (uint256)",
  "function persistenceStatus(bytes32 cidDigest) view returns (uint32 replicas, bool adequate, bool dueForRenewal, uint64 earliestExpiryEpoch)",
  "event DealRegistered(bytes32 indexed cidDigest, uint64 indexed dealId, uint64 indexed providerId, uint64 startEpoch, uint64 endEpoch)",
  "event RenewalRequired(bytes32 indexed cidDigest, uint32 activeReplicas, uint64 atEpoch)",
] as const;

export const STUDY_ABI = [
  "function participantCount() view returns (uint32)",
  "function hasSubmitted(address) view returns (bool)",
  "function submit(bytes32 encGroup, bytes32 encAnxiety, bytes32 encPanic, bytes inputProof)",
  "function anxietyAggregate(uint8 group) view returns (bytes32 n, bytes32 sum, bytes32 sumSq)",
  "function panicAggregate(uint8 group) view returns (bytes32 n, bytes32 sum, bytes32 sumSq)",
  "event ResponseSubmitted(address indexed participant, uint32 participantIndex)",
] as const;
