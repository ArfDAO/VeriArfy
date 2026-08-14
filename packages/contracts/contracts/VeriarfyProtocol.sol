// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, ebool, euint8, euint32, externalEuint8} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

import {IDataProvenanceVerifier} from "./interfaces/IDataProvenanceVerifier.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title   VeriarfyProtocol
 * @notice  Sifreli dozaj havuzu + IPFS indeksi + esikli (BSKK-44) cozum erisimi.
 *
 * @dev  NE YAPAR
 *       1. Katilimcinin IPFS'teki sifreli panel blobunun adresini indeksler.
 *       2. Panelden gelen sifreli dozajlari (0/1/2) HIC ACMADAN kuresel bir
 *          `euint32` havuzda toplar.
 *       3. Havuzun cozulmesini tek bir kuruma birakmaz: yetkili dugumlerin
 *          M-of-N onayi olmadan hicbir adres cozum yetkisi alamaz.
 *
 *       ZAMA fhEVM — API NOTU
 *       Kullanilan surum: fhevm/solidity 0.11.x. `FHE` kutuphanesi,
 *       `externalEuint8` girdi tipi ve `FHE.fromExternal(...)`. Eski `TFHE.sol`
 *       / `einput` / `TFHE.asEuint8(einput, proof)` API'si (fhevm <= 0.6)
 *       bu surumde YOKTUR; karistirilirsa derlenmez.
 *
 *       SURUM SABITLEMESI — ZINCIR ADRESLERI BURADAN GELIR
 *       `ZamaEthereumConfig`, chainId'ye gore ACL/Coprocessor/KMSVerifier
 *       adreslerini kendisi secer. Bu adresler surume GOMULUDUR. Zama
 *       Sepolia'daki yigini bir kez yeniden dagitti ve eski nesil (solidity
 *       0.8 + relayer.testnet.zama.cloud) hizmetten kalkti; eski adreslerde
 *       hala kod duruyor ama relayer'in DNS kaydi bile yok. Yani surum
 *       uyumsuzlugu derleme hatasi olarak degil, "gecerli gorunup calismayan
 *       bir dagitim" olarak ortaya cikar. Istemci tarafiyla ayni nesli
 *       kullandigimizi `scripts/live-check.ts` gercek agda dogrular.
 *
 *       ACL — EN SIK YAPILAN HATA
 *       fhEVM'de bir sifreli deger, acikca izin verilmedikce bir sonraki
 *       islemde kullanilamaz. Depolanan her handle icin `FHE.allowThis(...)`
 *       cagrilir; aksi halde ikinci `aggregateDosage` cagrisi revert eder.
 *
 *       COZUM NASIL OLUYOR
 *       Kontrat sifre cozmez. Esik saglandiginda yalnizca ACL izni verilir
 *       (`FHE.allow`); asil cozum Zama Gateway/KMS uzerinden, izinli adresin
 *       imzasiyla zincir disinda yapilir.
 */
contract VeriarfyProtocol is ZamaEthereumConfig, Ownable, ReentrancyGuard {
    // ---------------------------------------------------------------------------------
    // Hatalar
    // ---------------------------------------------------------------------------------

    error NotAuthorizedNode(address caller);
    error AlreadyAuthorized(address node);
    error NotAuthorized(address node);
    error ZeroAddress();
    error EmptyCid();
    error AlreadyAggregated(address participant);
    error InvalidThreshold(uint256 threshold, uint256 nodeCount);
    error UnknownRequest(uint256 requestId);
    error AlreadyApproved(uint256 requestId, address node);
    error AlreadyFinalized(uint256 requestId);
    error NotEnoughParticipants(uint32 have, uint32 need);
    error PoolEmpty();
    error InvalidProvenanceProof();
    error ProvenanceNullifierSpent(uint256 nullifierHash);
    error UnknownAccreditedRoot(uint256 root);
    error AccreditedRootExpired(uint256 root);
    error ValueOutOfField();
    error NotAParticipant(address account);
    error AlreadyGranted(address participant, address researcher);
    error NoActiveGrant(address participant, address researcher);
    error EmptyQueryTypes();
    error ExpirationInPast(uint256 expirationBlock);
    error NotQueryGateway(address caller);
    error UnknownQueryType(uint8 queryType);
    error NoAuthorizedNodes();

    // ---------------------------------------------------------------------------------
    // Olaylar
    // ---------------------------------------------------------------------------------

    event RecordSubmitted(address indexed participant, bytes32 indexed cidDigest, bool replaced);
    event AccreditedRootUpdated(uint256 indexed newRoot, uint256 previousRoot);
    event AccessGranted(
        address indexed participant,
        address indexed researcher,
        uint8 queryTypes,
        uint256 expirationBlock
    );
    event AccessRevoked(address indexed participant, address indexed researcher, uint256 atBlock);
    event QueryGatewayUpdated(address indexed gateway);
    event DosageAggregated(address indexed participant, uint32 participantCount);
    event NodeAuthorized(address indexed node);
    event NodeRevoked(address indexed node);
    event ThresholdUpdated(uint256 threshold);
    event MinParticipantsUpdated(uint32 minParticipants);
    event DisclosureRequested(uint256 indexed requestId, address indexed requester, uint32 snapshotCount);
    event DisclosureApproved(uint256 indexed requestId, address indexed node, uint256 approvals);
    event DisclosureGranted(uint256 indexed requestId, uint32 snapshotCount);

    // ---------------------------------------------------------------------------------
    // IPFS indeksi
    // ---------------------------------------------------------------------------------

    /**
     * @notice Katilimci adresi -> sifreli blobun IPFS icerik ozeti.
     *
     * @dev Tam CID string'i degil **digest** tutulur: CIDv1 / sha2-256 icin
     *      digest tam 32 bayttir ve tek slota sigar (string tutmak her kayitta
     *      birden fazla slot + uzunluk demekti). Digest'ten tam CID'i geri
     *      uretmek icin surum ve codec on eki gerekir; uygulama tarafinda bu
     *      sabittir (bkz. `packages/web/src/lib/storage.ts`, `cidVersion: 1`),
     *      dolayisiyla CID digest'ten yeniden kurulabilir.
     */
    mapping(address => bytes32) public userCIDs;

    // ---------------------------------------------------------------------------------
    // ZK veri kokeni (ZK-Data Provenance)
    // ---------------------------------------------------------------------------------

    /// @notice `data_provenance` devresinin Groth16 dogrulayicisi.
    IDataProvenanceVerifier public immutable provenanceVerifier;

    /**
     * @notice Bu kontratin kapsam ayraci (devredeki `externalNullifier`).
     *
     * @dev ALAN AYRIMI — kasitli olarak `VeriArfyRegistry.EXTERNAL_NULLIFIER`
     *      (= 1) degerinden FARKLIDIR. Iki devre ayni nullifier bicimini
     *      kullanir: `Poseidon(externalNullifier, gizliDeger)`. Kapsam degeri
     *      ayrisMAZsa, iki devrenin nullifier'lari ayni uzaya duser ve birinin
     *      kaydi digerini bloke edebilir. Nullifier'lar ayrica AYRI
     *      mapping'lerde tutulur; iki koruma birlikte gerekir.
     */
    uint256 public constant PROVENANCE_SCOPE = 2;

    /// @dev BN254 skaler alan mertebesi; disaridan gelen alan elemanlari icin sinir.
    uint256 internal constant SNARK_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /**
     * @notice Eski kokun gecerli kalma suresi.
     *
     * @dev Kok, akredite kurum eklendikce degisir. Bu pencere olmasa, kanit
     *      uretirken kok guncellenen her kullanici basarisiz olurdu — kanit
     *      uretimi ~1 saniye surer ama islem madenciye ulasana kadar gecen sure
     *      belirsizdir.
     */
    uint256 public constant ACCREDITED_ROOT_VALIDITY = 1 hours;

    /// @notice Akredite kurumlar Merkle agacinin guncel koku.
    uint256 public accreditedRoot;

    /// @notice Kok -> yazildigi zaman. Gecerlilik penceresi bundan hesaplanir.
    mapping(uint256 root => uint256 timestamp) public accreditedRootTimestamp;

    /// @notice Harcanmis koken nullifier'lari — ayni imzali kayit iki kez giremez.
    mapping(uint256 nullifierHash => bool spent) public provenanceNullifierSpent;

    /**
     * @notice Katilimci -> panelinin taahhudu (`Poseidon(paket, salt)`).
     *
     * @dev Panelin kendisi buradan cikarilamaz; salt bilinmedikce taahhut tek
     *      yonludur. Saklanmasinin sebebi denetlenebilirlik: bir kaydin hangi
     *      imzali panele karsilik geldigi sonradan kanitlanabilir.
     */
    mapping(address => uint256) public panelCommitment;

    /// @notice Kayit yapmis katilimci sayisi (indeks buyuklugu).
    uint32 public recordCount;

    // ---------------------------------------------------------------------------------
    // Sifreli havuz
    // ---------------------------------------------------------------------------------

    /// @notice Tum katilimcilarin dozaj toplami — sifreli, hicbir zaman acilmadi.
    euint32 private _dosagePool;

    /// @notice Havuza katkida bulunan katilimci sayisi (acik: ortalama icin gerekli).
    uint32 public participantCount;

    /// @notice Bir adres havuza yalnizca bir kez katkida bulunabilir.
    mapping(address => bool) public hasAggregated;

    /**
     * @notice Katilimcinin havuza katilma sirasi (1 tabanli; 0 = katilimci degil).
     *
     * @dev Gelir paylasiminin temeli. Bir sorgu acildiginda o andaki
     *      `participantCount` anlik goruntu olarak saklanir; indeksi bu
     *      sayidan kucuk esit olan her adres o sorguya dahildir. Bu sayede
     *      odeme sozlesmesi katilimci listesi tutmak ya da dolasmak zorunda
     *      kalmaz.
     */
    mapping(address => uint32) public participantIndex;

    // ---------------------------------------------------------------------------------
    // Gizlilik Paneli — kurum bazli erisim izinleri (rapor §3.4)
    // ---------------------------------------------------------------------------------

    /**
     * @notice Katilimcinin bir arastirmaciya verdigi izin.
     *
     * @dev Alanlar rapor §3.4'teki `Permission` yapisini birebir karsilar.
     *      Zaman ekseni BLOK NUMARASIDIR; rapor da `expirationBlock` diyor.
     *
     *      `revokedAtBlock` neden var: iznin ne zaman kalktigi bilinmezse,
     *      izin verildigi donemde acilmis bir sorgudan hak edilen pay da
     *      iptalle birlikte kaybolurdu. Iki sinir birlikte "hangi bloklarda
     *      gecerliydi" araligini verir.
     */
    struct Permission {
        bool isAllowed;
        /// @dev Izin verilen sorgu tipleri (bit maskesi). Bkz. `QUERY_TYPE_*`.
        uint8 queryTypes;
        uint256 grantedAtBlock;
        /// @dev Iptal blogu; izin surerken `type(uint256).max`.
        uint256 revokedAtBlock;
        /// @dev Otomatik sona erme; 0 = suresiz.
        uint256 expirationBlock;
        /// @dev Bilgi amacli ust sinir; 0 = sinirsiz.
        uint256 maxQueries;
    }

    uint8 public constant QUERY_TYPE_GWAS = 1;
    uint8 public constant QUERY_TYPE_ML = 2;
    uint8 public constant QUERY_TYPE_STATISTICS = 4;

    mapping(address participant => mapping(address researcher => Permission)) private _permissions;

    /**
     * @notice Bir arastirmaciya SU AN izin veren katilimci sayisi.
     *
     * @dev Sorgu ucreti ve dagitim havuzu bu sayidan hesaplanir: arastirmaci
     *      yalnizca kendisine izin vermis kisilerin verisi kadar oder ve
     *      yalnizca o kisiler pay alir. Sayaci tutmak, sorgu aninda katilimci
     *      listesini dolasmayi gereksiz kilar (O(1)).
     */
    mapping(address researcher => uint32) public consentCount;

    /**
     * @notice Gecerli dozaj ust siniri.
     * @dev Panel `0 | 1 | 2` uretir. Kotu niyetli bir istemci 255 gonderip
     *      toplami bozabilecegi icin deger homomorfik olarak kirpilir —
     *      kirpma sifreliyken yapilir, yani degeri kimse gormez.
     */
    uint8 public constant MAX_DOSAGE = 2;

    // ---------------------------------------------------------------------------------
    // GWAS — sifreli kontenjans tablosu (rapor §3.3)
    // ---------------------------------------------------------------------------------

    /// @notice Kontrol (saglikli) grubu.
    uint8 public constant GROUP_CONTROL = 0;

    /// @notice Vaka (hasta) grubu.
    uint8 public constant GROUP_CASE = 1;

    /// @notice Grup sayisi (vaka / kontrol).
    uint8 public constant GROUP_COUNT = 2;

    /// @notice Dozaj seviyeleri: 0, 1, 2.
    uint8 public constant DOSAGE_LEVELS = 3;

    /**
     * @notice 2x3 sifreli kontenjans tablosu: `[grup][dozaj]` hucre sayaci.
     *
     * @dev  NEDEN TABLO, NEDEN TEK TOPLAM DEGIL
     *
     *       `_dosagePool` yalnizca allel frekansini verir
     *       (`havuz / (2 * katilimci)`). GWAS'in sordugu soru ise farklidir:
     *       "bu varyant hasta grubunda kontrol grubundan anlamli olcude daha
     *       sik mi?" Bunu yanitlamak icin iki grubun dozaj DAGILIMI gerekir —
     *       tek bir toplam bu bilgiyi tasimaz.
     *
     *       Tablo doldurulurken ne grup ne de dozaj acilir: her hucre icin
     *       "bu katilimci bu hucreye mi ait" sorusu homomorfik olarak sorulur
     *       ve sonuc 0/1 olarak eklenir.
     *
     *       KI-KARE NEDEN ZINCIRDE HESAPLANMIYOR
     *
     *       χ² = Σ (G−B)²/B formulu **bolme** icerir. Sifreli bolme TFHE'de
     *       pratik degildir (her islem bir bootstrapping zinciri gerektirir).
     *       Bu yuzden zincirde yalnizca 6 SAYIM biriktirilir; esikli acilimla
     *       bu 6 sayi cozulur ve χ² ile p-degeri duz metinde hesaplanir.
     *
     *       Gizlilik bozulmaz: cozulen sey bireyin verisi degil, grup
     *       toplamlaridir — ve `minParticipants` (k-anonimlik) esigi altinda
     *       acilim zaten baslatilamaz.
     *
     *       Rapor §2.1.1 "PBS ile esik karsilastirmasi yapilabilir" diyor; bu
     *       dogru ama χ²'nin TAMAMINI sifreli hesaplamak gereksiz pahalidir.
     */
    euint32[3][2] private _contingency;

    // ---------------------------------------------------------------------------------
    // BSKK-44 — yetkili dugumler ve esikli erisim
    // ---------------------------------------------------------------------------------

    /// @notice Konsensus uyesi dugumler.
    mapping(address => bool) public isAuthorizedNode;

    /// @notice Yetkili dugum sayisi (N).
    uint256 public authorizedNodeCount;

    /// @notice Cozum yetkisi icin gereken onay sayisi (M).
    uint256 public disclosureThreshold;

    /**
     * @notice Sorgu tipi -> gereken onay orani (10 uzerinden).
     *
     * @dev RAPOR §2.6 — kademeli yetkilendirme, birebir:
     *
     *        genel istatistik sorgulari      -> 4/10
     *        bireysel mutasyon arastirmalari -> 7/10
     *        populasyon genetigi analizleri  -> 9/10
     *
     *      Eslesme:
     *        QUERY_TYPE_STATISTICS -> genel istatistik      -> 4
     *        QUERY_TYPE_ML         -> bireysel mutasyon     -> 7
     *        QUERY_TYPE_GWAS       -> populasyon genetigi   -> 9
     *
     *      Neden pay olarak saklaniyor: rapor esikleri "X/10" diye veriyor,
     *      yani dugum sayisina GORE. Mutlak sayi saklansaydi, dugum sayisi
     *      degistiginde oran sessizce kayardi.
     */
    mapping(uint8 queryType => uint8 outOfTen) public thresholdFraction;

    /// @dev Rapor esiklerinin paydasi.
    uint8 public constant THRESHOLD_DENOMINATOR = 10;

    /**
     * @notice Sorgu talebini acmaya yetkili kapi (odeme sozlesmesi).
     *
     * @dev Rapor §2.5.2'de bu rol "Gateway" olarak geciyor: arastirmacinin
     *      yetkisini dogrulayan ve talebi ileten bilesen. Bizde bu is odeme
     *      sozlesmesindedir — cunku yetki kontrolu (kayitli arastirmaci mi)
     *      ve ucret tahsili orada yapilir.
     */
    address public queryGateway;

    /**
     * @notice Cozum icin gereken en az katilimci sayisi (k-anonimlik).
     *
     * @dev Kritik gizlilik korumasi: havuzda tek katilimci varken toplami
     *      cozmek, dogrudan o kisinin dozajini okumak demektir. Esik kac
     *      kurumun onayladigindan bagimsiz olarak bu siniri asamaz.
     */
    uint32 public minParticipants;

    struct DisclosureRequest {
        /**
         * @dev Talebi acan ARASTIRMACI (rapor §2.6: "Access Request
         *      Transaction"). Onceki surumde burasi bir dugumdu; rapor §2.5.2
         *      ise cozulen sonucun arastirmaciya iletildigini soyluyor.
         */
        address requester;
        /// @dev Sorgu hassasiyeti; gereken esigi bu belirler (rapor §2.6).
        uint8 queryType;
        /// @dev Talep aninda hesaplanan onay sayisi. Sonradan dugum eklenip
        ///      cikarilsa bile bu talebin esigi degismez.
        uint32 requiredApprovals;
        uint32 snapshotCount;
        uint64 requestedAt;
        bool finalized;
        /// @dev Talep anindaki havuzun anlik goruntusu; havuz aksamalar boyunca
        ///      buyumeye devam eder, verilen izin bu donmus degere baglidir.
        euint32 snapshot;
        /**
         * @dev Talep anindaki kontenjans tablosunun anlik goruntusu.
         *
         * Havuzla ayni gerekce: talep acildiktan sonra yeni katilimcilar
         * gelmeye devam eder. Cozum izni, talep anindaki donmus tabloya
         * baglidir; aksi halde onaylayanlarin gordugu sayilar oy verdikleri
         * sayilar olmazdi.
         */
        euint32[3][2] contingencySnapshot;
        address[] approvers;
    }

    mapping(uint256 => DisclosureRequest) private _requests;
    mapping(uint256 => mapping(address => bool)) public hasApproved;

    /// @notice Bir sonraki talebin kimligi.
    uint256 public nextRequestId;

    // ---------------------------------------------------------------------------------

    modifier onlyAuthorizedNode() {
        if (!isAuthorizedNode[msg.sender]) revert NotAuthorizedNode(msg.sender);
        _;
    }

    /**
     * @param initialOwner   Yetkili dugumleri atayacak yonetici (cok imzali cuzdan olmali).
     * @param threshold      Baslangic M degeri; dugum eklendikce guncellenebilir.
     * @param minParticipants_ Cozum icin gereken en az katilimci sayisi.
     * @param provenanceVerifier_ `data_provenance` devresinin dogrulayicisi.
     * @param initialAccreditedRoot Akredite kurumlar agacinin baslangic koku
     *        (0 verilirse sonradan `updateAccreditedRoot` ile yazilir; kok
     *        yazilana kadar hicbir kayit kabul edilmez).
     */
    constructor(
        address initialOwner,
        uint256 threshold,
        uint32 minParticipants_,
        address provenanceVerifier_,
        uint256 initialAccreditedRoot
    ) Ownable(initialOwner) {
        if (threshold == 0) revert InvalidThreshold(threshold, 0);
        if (provenanceVerifier_ == address(0)) revert ZeroAddress();

        disclosureThreshold = threshold;
        minParticipants = minParticipants_;
        provenanceVerifier = IDataProvenanceVerifier(provenanceVerifier_);

        // Rapor §2.6'daki kademeli esikler.
        thresholdFraction[QUERY_TYPE_STATISTICS] = 4;
        thresholdFraction[QUERY_TYPE_ML] = 7;
        thresholdFraction[QUERY_TYPE_GWAS] = 9;

        if (initialAccreditedRoot != 0) {
            _setAccreditedRoot(initialAccreditedRoot);
        }

        // Havuzu sifir olarak baslat ve kontrata kendi degerini kullanma izni ver.
        // Bu satir olmadan ilk `aggregateDosage` cagrisi ACL nedeniyle revert eder.
        _dosagePool = FHE.asEuint32(0);
        FHE.allowThis(_dosagePool);

        // Kontenjans tablosunun 6 hucresi de ayni sebeple baslatilmali.
        for (uint8 g = 0; g < GROUP_COUNT; ++g) {
            for (uint8 level = 0; level < DOSAGE_LEVELS; ++level) {
                _contingency[g][level] = FHE.asEuint32(0);
                FHE.allowThis(_contingency[g][level]);
            }
        }
    }

    // ---------------------------------------------------------------------------------
    // 1) IPFS kayit indeksi
    // ---------------------------------------------------------------------------------

    /**
     * @notice Akredite kurumlar agacinin kokunu gunceller.
     *
     * @dev Yeni bir kurum akredite edildiginde zincir disinda hesaplanan kok
     *      buraya yazilir. Eski kok `ACCREDITED_ROOT_VALIDITY` suresince
     *      gecerli kalir.
     */
    function updateAccreditedRoot(uint256 newRoot) external onlyOwner {
        if (newRoot == 0 || newRoot >= SNARK_FIELD) revert ValueOutOfField();
        _setAccreditedRoot(newRoot);
    }

    function _setAccreditedRoot(uint256 newRoot) private {
        uint256 previous = accreditedRoot;
        accreditedRoot = newRoot;
        accreditedRootTimestamp[newRoot] = block.timestamp;
        emit AccreditedRootUpdated(newRoot, previous);
    }

    function _validateAccreditedRoot(uint256 root) private view {
        if (root == accreditedRoot && root != 0) return;

        uint256 timestamp = accreditedRootTimestamp[root];
        if (timestamp == 0) revert UnknownAccreditedRoot(root);
        if (block.timestamp > timestamp + ACCREDITED_ROOT_VALIDITY) {
            revert AccreditedRootExpired(root);
        }
    }

    /**
     * @notice Katilimcinin sifreli blobunun IPFS ozetini, KOKEN KANITIYLA kaydeder.
     *
     * @dev  NEDEN KANIT SART
     *       Sifreli bir verinin icerigi okunamaz. Kanit olmadan, kotu niyetli
     *       bir kullanici rastgele baytlar yukleyip gelir havuzundan pay
     *       alabilirdi (rapor §1.5, "cop veri" krizi). Kanit su dortunu ayni
     *       anda baglar:
     *
     *         1. Panelin duz metni akredite bir kurumun EdDSA imzasini tasir,
     *         2. Panel bicim kurallarina uyar (her dozaj 0 | 1 | 2),
     *         3. Kanit `msg.sender`'a baglidir — baskasinin kaniti calinamaz,
     *         4. Kanit TAM OLARAK bu `cidDigest`e baglidir.
     *
     *       KAPSAM SINIRI — dikkat
     *       Kanit "panelin duz metni imzalidir" der; "bu CID'deki sifreli metin
     *       tam olarak o paneli sifreler" DEMEZ. O bag (Proof of Correct
     *       Encryption) bu devrede kurulu degildir. `aggregateDosage` yolunda
     *       ise Zama'nin girdi kaniti sifreli metnin gecerliligini zaten
     *       dogrular. Ayrinti: docs/mimari/0003-veri-kokeni-eddsa.md
     *
     * @param cidDigest    CIDv1 multihash digest'i (sha2-256, 32 bayt).
     * @param root         Kanitin uretildigi akredite kurumlar koku.
     * @param nullifierHash Poseidon(PROVENANCE_SCOPE, commitment).
     * @param commitment   Poseidon(paketlenmis panel, salt).
     * @param pA/pB/pC     Groth16 kanit bilesenleri.
     */
    function submitRecord(
        bytes32 cidDigest,
        uint256 root,
        uint256 nullifierHash,
        uint256 commitment,
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC
    ) external nonReentrant {
        if (cidDigest == bytes32(0)) revert EmptyCid();
        if (provenanceNullifierSpent[nullifierHash]) {
            revert ProvenanceNullifierSpent(nullifierHash);
        }

        _validateAccreditedRoot(root);

        // CID BAGLAMA — kritik satir.
        //
        // Yarilar KANITTAN degil, cagrida verilen digest'ten turetilir. Boylece
        // gecerli bir kanit baska bir bloba ilistirilemez: kanit farkli bir CID
        // icin uretildiyse asagidaki karsilastirma tutmaz.
        //
        // 256 bitlik digest 254 bitlik alana sigmadigi icin ikiye bolunur;
        // devredeki bolme ile birebir ayni (ust 128 bit / alt 128 bit).
        uint256 cidHigh = uint256(cidDigest) >> 128;
        uint256 cidLow = uint256(cidDigest) & type(uint128).max;

        uint256[7] memory publicSignals = [
            root,
            nullifierHash,
            commitment,
            PROVENANCE_SCOPE,
            cidHigh,
            cidLow,
            uint256(uint160(msg.sender))
        ];

        if (!provenanceVerifier.verifyProof(pA, pB, pC, publicSignals)) {
            revert InvalidProvenanceProof();
        }

        provenanceNullifierSpent[nullifierHash] = true;

        bool replaced = userCIDs[msg.sender] != bytes32(0);
        if (!replaced) {
            recordCount += 1;
        }

        userCIDs[msg.sender] = cidDigest;
        panelCommitment[msg.sender] = commitment;

        emit RecordSubmitted(msg.sender, cidDigest, replaced);
    }

    // ---------------------------------------------------------------------------------
    // 2) Sifreli toplama
    // ---------------------------------------------------------------------------------

    /**
     * @notice Sifreli bir dozaji kuresel havuza ekler. Deger hicbir noktada acilmaz.
     *
     * @dev  Akis:
     *       1. `FHE.fromExternal` girdinin gecerli bir sifreli metin oldugunu
     *          ZK girdi kanitiyla dogrular — rastgele bir handle enjekte edilemez.
     *       2. `FHE.min` ile 0..2 araligina homomorfik kirpma yapilir.
     *       3. `euint8` toplam, `euint32` havuza eklenir (genisleme kutuphanede
     *          tanimli: `add(euint32, euint8)`), boylece 255'te tasma olmaz.
     *       4. `FHE.allowThis` yeni handle'i bir sonraki islem icin kullanilabilir kilar.
     *
     * @param encDosage  Istemcide sifrelenmis dozaj (0 | 1 | 2).
     * @param inputProof Zama relayer'inin urettigi girdi kaniti.
     */
    function aggregateDosage(
        externalEuint8 encGroup,
        externalEuint8 encDosage,
        bytes calldata inputProof
    ) external nonReentrant {
        if (hasAggregated[msg.sender]) revert AlreadyAggregated(msg.sender);

        euint8 group = FHE.fromExternal(encGroup, inputProof);
        euint8 dosage = FHE.fromExternal(encDosage, inputProof);

        // Butunluk: arali disi degerleri sifreliyken kirp. Kotu niyetli bir
        // istemci 255 gonderip tablo ya da toplami bozamaz.
        dosage = FHE.min(dosage, FHE.asEuint8(MAX_DOSAGE));
        group = FHE.min(group, FHE.asEuint8(GROUP_CASE));

        _dosagePool = FHE.add(_dosagePool, dosage);
        FHE.allowThis(_dosagePool);

        // --- Kontenjans tablosu ---------------------------------------------
        //
        // Her hucre icin "bu katilimci buraya mi ait" sorusu homomorfik
        // sorulur. `FHE.asEuint32(ebool)` sonucu 0 veya 1'e cevirir; boylece
        // dogru hucre 1 artar, digerleri 0 eklenerek DEGISMEDEN kalir.
        //
        // Diger hucrelere de 0 eklenmesi israf degil zorunluluktur: hangi
        // hucrenin arttigi gizli kalmalidir. Kosullu yazim yapilsaydi, islem
        // izinden grup ve dozaj okunabilirdi.
        ebool[2] memory inGroup;
        inGroup[GROUP_CONTROL] = FHE.eq(group, GROUP_CONTROL);
        inGroup[GROUP_CASE] = FHE.eq(group, GROUP_CASE);

        for (uint8 level = 0; level < DOSAGE_LEVELS; ++level) {
            ebool atLevel = FHE.eq(dosage, level);

            for (uint8 g = 0; g < GROUP_COUNT; ++g) {
                euint32 cell = FHE.add(
                    _contingency[g][level],
                    FHE.asEuint32(FHE.and(inGroup[g], atLevel))
                );
                _contingency[g][level] = cell;
                FHE.allowThis(cell);
            }
        }

        hasAggregated[msg.sender] = true;
        participantCount += 1;

        // 1 TABANLI indeks — 0 "katilimci degil" anlamina gelir.
        //
        // Gelir paylasimi bunu kullanir: bir sorgu, acildigi andaki katilimci
        // sayisini (`snapshotCount`) dondurur. Indeksi bu sayidan kucuk esit
        // olan herkes o sorguya dahildir. Boylece odeme sozlesmesi katilimci
        // listesini dolasmak zorunda kalmaz — pay hesabi O(1) olur.
        participantIndex[msg.sender] = participantCount;

        emit DosageAggregated(msg.sender, participantCount);
    }

    // ---------------------------------------------------------------------------------
    // 3) Gizlilik Paneli — izin ver / geri al
    // ---------------------------------------------------------------------------------

    /**
     * @notice Bir arastirmaciya verinizi kullanma izni verir.
     *
     * @dev  Izin ancak veri havuza girdikten SONRA verilebilir; aksi halde
     *       `consentCount` gercekte var olmayan bir veriyi sayar ve
     *       arastirmaci bos veri icin oder.
     *
     * @param researcher      Izin verilen adres.
     * @param queryTypes      Bit maskesi: GWAS | ML | STATISTICS.
     * @param expirationBlock Otomatik sona erme blogu; 0 = suresiz.
     * @param maxQueries      Bilgi amacli ust sinir; 0 = sinirsiz.
     */
    function grantAccess(
        address researcher,
        uint8 queryTypes,
        uint256 expirationBlock,
        uint256 maxQueries
    ) external nonReentrant {
        if (researcher == address(0)) revert ZeroAddress();
        if (participantIndex[msg.sender] == 0) revert NotAParticipant(msg.sender);
        if (queryTypes == 0) revert EmptyQueryTypes();
        if (expirationBlock != 0 && expirationBlock <= block.number) {
            revert ExpirationInPast(expirationBlock);
        }

        Permission storage grant = _permissions[msg.sender][researcher];
        if (_isLive(grant)) revert AlreadyGranted(msg.sender, researcher);

        _permissions[msg.sender][researcher] = Permission({
            isAllowed: true,
            queryTypes: queryTypes,
            grantedAtBlock: block.number,
            revokedAtBlock: type(uint256).max,
            expirationBlock: expirationBlock,
            maxQueries: maxQueries
        });

        consentCount[researcher] += 1;
        emit AccessGranted(msg.sender, researcher, queryTypes, expirationBlock);
    }

    /**
     * @notice Verilen izni geri alir (rapor §3.4.1 "Revoke").
     *
     * @dev  KAPSAM — dogru anlasilmasi onemli:
     *       Iptal, iptalden SONRA acilacak sorgular icin gecerlidir. Iptalden
     *       once acilmis bir sorgudan hak edilen pay durur; hakedis o sorgunun
     *       acildigi blokta iznin gecerli olmasina baglidir.
     *
     *       Zaten hesaplanmis toplamdan verinin geri cikarilmasi mumkun
     *       DEGILDIR: havuz homomorfik bir toplamdir ve bir terimi cikarmak
     *       icin o terimin sifreli halinin ayrica saklanmasi gerekirdi.
     *       Rapor §3.4.1 "hesaplamaya dahil etmeye calisirsa revert eder"
     *       diyor; burada saglanan sey bunun gelecege donuk karsiligidir.
     */
    function revokeAccess(address researcher) external nonReentrant {
        Permission storage grant = _permissions[msg.sender][researcher];
        if (!_isLive(grant)) revert NoActiveGrant(msg.sender, researcher);

        grant.isAllowed = false;
        grant.revokedAtBlock = block.number;

        consentCount[researcher] -= 1;
        emit AccessRevoked(msg.sender, researcher, block.number);
    }

    /** @dev Izin su anda yururlukte mi (iptal edilmemis ve suresi gecmemis). */
    function _isLive(Permission storage grant) private view returns (bool) {
        if (!grant.isAllowed) return false;
        if (grant.expirationBlock != 0 && block.number >= grant.expirationBlock) {
            return false;
        }
        return true;
    }

    /**
     * @notice Izin BELIRLI BIR BLOKTA gecerli miydi?
     *
     * @dev Odeme sozlesmesi hakedisi bununla belirler. "Su an gecerli mi"
     *      sorusu yanlis olurdu: sorgu acildiktan sonra izni iptal eden bir
     *      katilimci, o sorgudan hak ettigi payi kaybederdi.
     */
    function hasAccessAt(
        address participant,
        address researcher,
        uint256 blockNumber
    ) external view returns (bool) {
        Permission storage grant = _permissions[participant][researcher];

        if (grant.grantedAtBlock == 0) return false;
        if (blockNumber < grant.grantedAtBlock) return false;
        if (blockNumber >= grant.revokedAtBlock) return false;
        if (grant.expirationBlock != 0 && blockNumber >= grant.expirationBlock) {
            return false;
        }
        return true;
    }

    /// @notice Izin kaydini oldugu gibi dondurur (panel bunu gosterir).
    function permission(address participant, address researcher)
        external
        view
        returns (Permission memory)
    {
        return _permissions[participant][researcher];
    }

    /**
     * @notice Havuzun sifreli handle'i.
     * @dev Handle herkese aciktir; **cozmek** ayri bir yetkidir ve yalnizca
     *      esikli onayla verilir. Handle'i gormek veriyi gormek degildir.
     */
    function dosagePool() external view returns (euint32) {
        return _dosagePool;
    }

    // ---------------------------------------------------------------------------------
    // 3) Yetkili dugum yonetimi
    // ---------------------------------------------------------------------------------

    function authorizeNode(address node) external onlyOwner {
        if (node == address(0)) revert ZeroAddress();
        if (isAuthorizedNode[node]) revert AlreadyAuthorized(node);

        isAuthorizedNode[node] = true;
        authorizedNodeCount += 1;
        emit NodeAuthorized(node);
    }

    function revokeNode(address node) external onlyOwner {
        if (!isAuthorizedNode[node]) revert NotAuthorized(node);

        isAuthorizedNode[node] = false;
        authorizedNodeCount -= 1;

        // Esik, kalan dugum sayisini asamaz; asarsa hicbir talep sonuclanamaz
        // ve havuz kalici olarak erisilemez hale gelirdi.
        if (disclosureThreshold > authorizedNodeCount && authorizedNodeCount > 0) {
            disclosureThreshold = authorizedNodeCount;
            emit ThresholdUpdated(disclosureThreshold);
        }

        emit NodeRevoked(node);
    }

    function setDisclosureThreshold(uint256 threshold) external onlyOwner {
        if (threshold == 0 || threshold > authorizedNodeCount) {
            revert InvalidThreshold(threshold, authorizedNodeCount);
        }
        disclosureThreshold = threshold;
        emit ThresholdUpdated(threshold);
    }

    function setMinParticipants(uint32 minParticipants_) external onlyOwner {
        minParticipants = minParticipants_;
        emit MinParticipantsUpdated(minParticipants_);
    }

    // ---------------------------------------------------------------------------------
    // 4) Esikli cozum erisimi (BSKK-44)
    // ---------------------------------------------------------------------------------

    /**
     * @notice Bir yetkili dugum havuzun cozulmesini talep eder.
     *
     * @dev Talep aninda havuzun **anlik goruntusu** alinir. Sonradan gelen
     *      katkilar bu goruntuyu degistirmez; boylece "onay verirken 500
     *      katilimci vardi, cozerken 501 oldu" gibi kayma olmaz ve ardisik iki
     *      goruntunun farkindan tek bir katilimcinin verisi cikarilamaz
     *      (bunun icin ayrica `minParticipants` siniri vardir).
     */
    /**
     * @notice Arastirmaci adina bir acilim talebi acar (rapor §2.6:
     *         "Access Request Transaction").
     *
     * @dev  YETKI — neden dogrudan arastirmaci degil de kapi cagiriyor
     *       Rapor §2.5.2'de bu adimi "Gateway" yapar: arastirmacinin
     *       yetkisini dogrular ve talebi iletir. Bizde kapi, odeme
     *       sozlesmesidir; kayitli arastirmaci kontrolu ve ucret emaneti
     *       orada yapilir. Bu kontratin arastirmaci kayit defterini
     *       tanimasina gerek kalmaz.
     *
     * @param researcher Talebi acan arastirmaci; esik saglandiginda cozum
     *        yetkisi BU ADRESE verilir (rapor §2.5.2 adim 6).
     * @param queryType  Sorgu hassasiyeti; gereken esik buna gore hesaplanir.
     */
    function requestDisclosure(
        address researcher,
        uint8 queryType
    ) external nonReentrant returns (uint256 requestId) {
        if (msg.sender != queryGateway) revert NotQueryGateway(msg.sender);
        if (researcher == address(0)) revert ZeroAddress();
        if (participantCount == 0) revert PoolEmpty();
        if (participantCount < minParticipants) {
            revert NotEnoughParticipants(participantCount, minParticipants);
        }

        uint32 required = requiredApprovals(queryType);

        requestId = nextRequestId++;

        DisclosureRequest storage request = _requests[requestId];
        request.requester = researcher;
        request.queryType = queryType;
        request.requiredApprovals = required;
        request.snapshotCount = participantCount;
        request.requestedAt = uint64(block.timestamp);
        request.snapshot = _dosagePool;

        // Anlik goruntu ayri bir handle olarak yasayacagi icin kontratin ona
        // erisim izni de ayrica verilmelidir.
        FHE.allowThis(request.snapshot);

        // Kontenjans tablosu da dondurulur — GWAS'in ki-kare girdisi budur.
        for (uint8 g = 0; g < GROUP_COUNT; ++g) {
            for (uint8 level = 0; level < DOSAGE_LEVELS; ++level) {
                request.contingencySnapshot[g][level] = _contingency[g][level];
                FHE.allowThis(request.contingencySnapshot[g][level]);
            }
        }

        emit DisclosureRequested(requestId, researcher, participantCount);

        // ONEMLI: talebi acan artik onay VERMEZ.
        //
        // Onceki surumde talebi bir dugum aciyor ve ilk onayi kendisi
        // veriyordu. Rapor §2.6'ya gore talebi arastirmaci acar; onay
        // yetkisi yalnizca kurumsal dugumlerdedir. Arastirmacinin kendi
        // talebini onaylamasi, mekanizmanin tamamini anlamsiz kilardi.
    }

    /**
     * @notice Bir sorgu tipi icin su an gereken onay sayisi.
     *
     * @dev Rapor §2.6 esikleri "X/10" oranidir; gercek dugum sayisina
     *      olceklenir. Yukari yuvarlanir: 7/10 orani 3 dugumde 2,1 degil
     *      3 onay ister — asagi yuvarlamak esigi sessizce gevsetirdi.
     */
    function requiredApprovals(uint8 queryType) public view returns (uint32) {
        uint8 fraction = thresholdFraction[queryType];
        if (fraction == 0) revert UnknownQueryType(queryType);

        uint256 nodes = authorizedNodeCount;
        if (nodes == 0) revert NoAuthorizedNodes();

        uint256 required = (nodes * fraction + THRESHOLD_DENOMINATOR - 1) / THRESHOLD_DENOMINATOR;
        return uint32(required == 0 ? 1 : required);
    }

    /// @notice Sorgu kapisini belirler (odeme sozlesmesi).
    function setQueryGateway(address gateway) external onlyOwner {
        if (gateway == address(0)) revert ZeroAddress();
        queryGateway = gateway;
        emit QueryGatewayUpdated(gateway);
    }

    /// @notice Bir talebin esigi saglanmis ve cozum yetkisi verilmis mi?
    function isDisclosureGranted(uint256 requestId) external view returns (bool) {
        return _requests[requestId].finalized;
    }

    /// @notice Baska bir yetkili dugum talebi onaylar; esige ulasilinca izin verilir.
    function approveDisclosure(uint256 requestId) external onlyAuthorizedNode nonReentrant {
        DisclosureRequest storage request = _requests[requestId];
        if (request.requester == address(0)) revert UnknownRequest(requestId);
        if (request.finalized) revert AlreadyFinalized(requestId);
        if (hasApproved[requestId][msg.sender]) revert AlreadyApproved(requestId, msg.sender);

        _approve(requestId, request);
    }

    /**
     * @dev Onayi kaydeder; esik saglandiysa **onaylayan her dugume** anlik
     *      goruntuyu cozme izni verir.
     *
     *      Izin yalnizca onaylayanlara verilir: cozum yetkisi kolektif kararin
     *      sonucudur, tek bir talep sahibinin odulu degil.
     */
    function _approve(uint256 requestId, DisclosureRequest storage request) private {
        hasApproved[requestId][msg.sender] = true;
        request.approvers.push(msg.sender);

        uint256 approvals = request.approvers.length;
        emit DisclosureApproved(requestId, msg.sender, approvals);

        // Esik, TALEP ANINDA sorgu tipine gore sabitlenmistir (rapor §2.6).
        if (approvals < request.requiredApprovals) return;

        request.finalized = true;

        // Cozum yetkisi ARASTIRMACIYA verilir — rapor §2.5.2 adim 6:
        // "Cozulen sonuc yalnizca arastirmacinin cuzdan adresine iletilir."
        //
        // Onceki surumde izin onaylayan dugumlere veriliyordu; bu, onaylayan
        // her kurumun sonucu gormesi demekti ve raporun akisiyla celisiyordu.
        FHE.allow(request.snapshot, request.requester);

        // Ki-kare icin 6 hucrenin tamami cozulebilmeli; tek tek izin verilir.
        for (uint8 g = 0; g < GROUP_COUNT; ++g) {
            for (uint8 level = 0; level < DOSAGE_LEVELS; ++level) {
                FHE.allow(request.contingencySnapshot[g][level], request.requester);
            }
        }

        emit DisclosureGranted(requestId, request.snapshotCount);
    }

    /// @notice Talebin durumu (sifreli goruntu haric).
    function disclosureRequest(
        uint256 requestId
    )
        external
        view
        returns (
            address requester,
            uint32 snapshotCount,
            uint64 requestedAt,
            bool finalized,
            uint256 approvals
        )
    {
        DisclosureRequest storage request = _requests[requestId];
        if (request.requester == address(0)) revert UnknownRequest(requestId);

        return (
            request.requester,
            request.snapshotCount,
            request.requestedAt,
            request.finalized,
            request.approvers.length
        );
    }

    /**
     * @notice Onaylanmis talebin sifreli anlik goruntusu.
     * @dev Handle'i herkes okuyabilir; cozebilmek icin ACL izni gerekir ve o
     *      izin yalnizca esige ulasan taleplerin onaylayanlarina verilmistir.
     */
    function disclosureSnapshot(uint256 requestId) external view returns (euint32) {
        DisclosureRequest storage request = _requests[requestId];
        if (request.requester == address(0)) revert UnknownRequest(requestId);
        return request.snapshot;
    }

    /**
     * @notice Talep anindaki sifreli kontenjans tablosu.
     *
     * @dev Donen 6 handle GWAS'in ki-kare girdisidir. Sira:
     *      `[GROUP_CONTROL][0..2]` ardindan `[GROUP_CASE][0..2]`.
     *      Handle'i gormek veriyi gormek DEGILDIR; cozmek ayri bir yetkidir ve
     *      yalnizca esikli onayla verilir.
     */
    function disclosureContingency(
        uint256 requestId
    ) external view returns (euint32[3][2] memory) {
        DisclosureRequest storage request = _requests[requestId];
        if (request.requester == address(0)) revert UnknownRequest(requestId);
        return request.contingencySnapshot;
    }

    /**
     * @notice Guncel (dondurulmamis) kontenjans tablosunun handle'lari.
     *
     * @dev Panel ve izleme icin. Cozmek yine esikli onaya baglidir.
     */
    function contingencyTable() external view returns (euint32[3][2] memory) {
        return _contingency;
    }

    /// @notice Talebi onaylayan dugumler.
    function disclosureApprovers(uint256 requestId) external view returns (address[] memory) {
        return _requests[requestId].approvers;
    }
}
