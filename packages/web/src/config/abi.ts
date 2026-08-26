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
 * IZIN KAPISI KALKTI (bkz. `VeriarfyProtocol.leavePool`): yukleme zaten
 * izindir, geriye "havuzdan cikma" hakki kaldi.
 */
export const PROTOCOL_ABI = [
  "function participantCount() view returns (uint32)",
  "function recordCount() view returns (uint32)",
  "function participantIndex(address) view returns (uint32)",
  "function userCIDs(address) view returns (bytes32)",
  "function panelCommitment(address) view returns (uint256)",
  "function PROVENANCE_SCOPE() view returns (uint256)",
  "function hasAggregated(address) view returns (bool)",
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
  "function contributeDosages(bytes32[] encDosages, uint256 coverageMask, bytes inputProof)",
  "event Enrolled(address indexed participant)",
  "event DosagesContributed(address indexed participant, uint32 fromSnp, uint32 toSnp, uint32 covered)",
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
  "function isDisclosureGranted(uint256 requestId) view returns (bool)",
  "function challengeWindowEnd(uint256 requestId) view returns (uint256)",
  "function challengePeriod() view returns (uint256)",
  "function executeDisclosure(uint256 requestId)",
  "function approveDisclosure(uint256 requestId)",
  "function isAuthorizedNode(address node) view returns (bool)",
  "function isDisclosureRevoked(uint256 requestId) view returns (bool)",
  "function isDisclosureGranted(uint256 requestId) view returns (bool)",
  "function disclosureRequest(uint256 requestId) view returns (address requester, uint32 snapshotCount, uint64 requestedAt, bool finalized, uint256 approvals)",
  "function disclosureContingencyAt(uint256 requestId, uint32 snp) view returns (bytes32[3][2])",
  "function disclosureSnpIds(uint256 requestId) view returns (uint32[])",
  "function disclosureMetricIds(uint256 requestId) view returns (uint32[])",
  "function requestDisclosureFields(address researcher, uint8 queryType, uint32[] snpIds, uint32[] metricIds) returns (uint256)",
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
  // Kapsama — kimin hangi alanda GERCEK verisi var. Odeme buna gore dagitilir.
  "function snpCoverageCount(uint32 snp) view returns (uint32)",
  "function hasSnpCoverage(address participant, uint32 snp) view returns (bool)",
  "function snpCoverageWeight(address participant, uint32[] snpIds) view returns (uint32)",
  "function snpCoverageTotal(uint32[] snpIds) view returns (uint256)",
  "function aggregateDosage(bytes32 encGroup, bytes32 encDosage, bytes inputProof)",
  "event DosageAggregated(address indexed participant, uint32 participantCount)",
  // IZIN KAPISI KALKTI — yukleme zaten izindir. Geriye "havuzdan cikma" kaldi.
  "function leavePool()",
  "function leftPoolAtBlock(address participant) view returns (uint256)",
  "function wasInPoolAt(address participant, uint256 blockNumber) view returns (bool)",
  "event LeftPool(address indexed participant, uint256 atBlock)",
  "event RecordSubmitted(address indexed participant, bytes32 indexed cidDigest, bool replaced, bool attested)",
  // ZK koken kaniti — kapsama bitleri devrenin ACIK CIKTISIDIR.
  "function submitRecord(bytes32 cidDigest, bool attested, uint256 root, uint256 nullifierHash, uint256 commitment, uint256[5] coverage, uint256[2] pA, uint256[2][2] pB, uint256[2] pC)",
  "function recordAttested(address) view returns (bool)",
  "function COVERAGE_WORDS() view returns (uint256)",
  "function COVERAGE_BITS_PER_WORD() view returns (uint256)",
  "event CoverageProven(address indexed participant, uint32 covered)",
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
  "function contributeBiomarkers(bytes32[] encValues, uint256 coverageMask, bytes inputProof)",
  "function biomarkerAggregate(uint32 metric, uint8 group) view returns (bytes32 sum, bytes32 sumSq, bytes32 count)",
  // Kapsama — odeme kullanilan metrige gore dagitilir.
  "function metricCoverageCount(uint32 metric) view returns (uint32)",
  "function hasMetricCoverage(address participant, uint32 metric) view returns (bool)",
  "function metricCoverageWeight(address participant, uint32[] metricIds) view returns (uint32)",
  "function metricCoverageTotal(uint32[] metricIds) view returns (uint256)",
  "function disclosureBiomarkerAt(uint256 requestId, uint32 metric, uint8 group) view returns (bytes32 sum, bytes32 sumSq, bytes32 count)",
  "event BiomarkersContributed(address indexed participant, uint32 fromMetric, uint32 toMetric, uint32 covered)",
  "event BiomarkerPanelCompleted(address indexed participant)",
] as const;

/**
 * VeriarfyStaking — kripto-ekonomik guvenlik (rapor §2.7).
 *
 * Onay yetkisi YETKILENDIRME ile bitmiyor: dugumun yeterli teminati da
 * olmali. Gereken teminat havuzun ekonomik degeriyle birlikte BUYUR
 * (`minStake = baseStake x log2(toplamDeger / esik)`), yani dun yeten bir
 * teminat bugun yetmeyebilir. Arayuz bunu onceden okur.
 */
export const STAKING_ABI = [
  "function canApprove(address node) view returns (bool)",
  "function stakeOf(address node) view returns (uint256)",
  "function minStake() view returns (uint256)",
  "function isBanned(address node) view returns (bool)",
  "function stake() payable",
] as const;

/** VeriarfyPayments — hesaplama basina odeme ve gelir paylasimi. */
export const PAYMENTS_ABI = [
  "function nextQueryId() view returns (uint256)",
  "function treasuryBalance() view returns (uint256)",
  "function liquidityShareBps() view returns (uint16)",
  "function baseFee() view returns (uint256)",
  "function perRecordFee() view returns (uint256)",
  "function maxScarcityBps() view returns (uint16)",
  "function quote() view returns (uint256 fee, uint256 records)",
  "function quoteForFields(uint32[] snpIds, uint32[] metricIds) view returns (uint256 fee, uint256 records)",
  "function researchers() view returns (address)",
  "function claimable(uint256 queryId, address account) view returns (uint256)",
  "function pendingRewards(address account) view returns (uint256 total, uint256[] queryIds)",
  "function hasClaimed(uint256 queryId, address account) view returns (bool)",
  "function query(uint256 queryId) view returns (address researcher, uint256 fee, uint256 liquidityPot, uint32 snapshotCount, uint256 openedAtBlock, uint256 claimedTotal, uint256 disclosureRequestId, bool settled, bool refunded, uint256 coverageTotal)",
  "function claim(uint256 queryId) returns (uint256)",
  "function openQuery(uint8 queryType) returns (uint256)",
  "function openQueryFields(uint8 queryType, uint32[] snpIds, uint32[] metricIds) returns (uint256)",
  "function settleQuery(uint256 queryId)",
  // Nadirlik anlik goruntusu — payin nasil hesaplandigini panelde gostermek icin.
  "function weightOf(uint256 queryId, address account) view returns (uint256)",
  // Kullanima gore odeme: pay = kac alana veri verdin.
  "function coverageWeight(uint256 queryId, address account) view returns (uint256)",
  "function weightedCoverage(uint256 queryId, address account) view returns (uint256)",
  "function weightedTotal(uint256 queryId) view returns (uint256)",
  "function potSplit(uint256 queryId) view returns (uint256 usagePot, uint256 bonusPot)",
  "function usageShareBps() view returns (uint16)",
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
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
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
