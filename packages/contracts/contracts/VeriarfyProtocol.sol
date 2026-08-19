// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {
    FHE,
    ebool,
    euint8,
    euint32,
    euint64,
    externalEuint8,
    externalEuint32
} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaConfig, ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

import {ContingencyStats} from "./libraries/ContingencyStats.sol";

import {IVeriarfyBiomarkers} from "./interfaces/IVeriarfyBiomarkers.sol";

import {IDataProvenanceVerifier} from "./interfaces/IDataProvenanceVerifier.sol";
import {IKMSVerifier} from "./interfaces/IKMSVerifier.sol";
import {IVeriarfyStaking} from "./interfaces/IVeriarfyStaking.sol";

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
    error RarityAlreadyRequested(address participant);
    error RarityNotRequested(address participant);
    error RarityAlreadyConfirmed(address participant);
    error InvalidDecryptionProof(address participant);
    error NotFinalized(uint256 requestId);
    error DisclosureRevoked(uint256 requestId);
    error ChallengePeriodOpen(uint256 requestId, uint256 openUntilBlock);
    error NotStakingModule(address caller);
    error NodeNotStaked(address node);
    error ChallengeUnresolved(uint256 requestId);
    error NoHeirNodes();
    error NotHeirNode(address caller);
    error UseBatchApi(uint32 snpCount);
    error AlreadyEnrolled(address participant);
    error NotEnrolled(address participant);
    error EmptyBatch();
    error TooManySnps(uint32 requested, uint32 available);
    error PanelFrozen();
    error InvalidSnpCount(uint32 value);
    error InvalidSnpWindow(uint32 requested, uint32 maximum);
    error SnpOutsideWindow(uint32 snp, uint32 from, uint32 to);
    error InvalidMetricWindow(uint32 requested, uint32 maximum);
    error ModuleAlreadyLocked();

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
    /// @dev `handle` disariya verilir: relayer'a `publicDecrypt` bununla cagrilir.
    event RarityAssessmentRequested(address indexed participant, bytes32 handle);
    event RarityConfirmed(address indexed participant, bool isRare, uint32 rareCarrierCount);
    /// @dev Esik saglandi; itiraz suresi `openUntilBlock`'a kadar acik.
    event DisclosureFinalized(uint256 indexed requestId, uint256 openUntilBlock);
    event DisclosureRevokedByChallenge(uint256 indexed requestId);
    event StakingModuleUpdated(address indexed module);
    event ChallengePeriodUpdated(uint256 blocks);
    event HeirNodeAuthorized(address indexed node);
    event HeirNodeRevoked(address indexed node);
    event Heartbeat(address indexed node, uint256 atBlock);
    event Enrolled(address indexed participant);
    event DosagesContributed(address indexed participant, uint32 fromSnp, uint32 toSnp);
    event PanelConfigured(
        uint32 snpCount,
        uint32 rareSnpIndex,
        bytes32 panelHash,
        string panelUri
    );
    event BiomarkerModuleUpdated(address indexed module);
    event LivenessTimeoutUpdated(uint256 blocks);
    event FailoverDeclared(uint256 atBlock);
    event FailoverCleared(uint256 atBlock);

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
    /// @dev `hasAggregated` artik bir gorunumdur (asagida); panel cok SNP'li
    ///      olabildigi icin "tamamladi mi" tek bir bayrakla temsil edilemez.
    bool public panelFrozen;

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

    /**
     * @notice "Bu varyant kullanicinin dosyasinda YOK" isareti.
     *
     * @dev  NEDEN 0 DEGIL
     *
     *       Eksik bir varyanti 0 yazmak sessiz bir yalandir: 0, "homozigot
     *       referans" demektir — yani "bu mutasyonu tasimiyor". Oysa dogru
     *       ifade "bilmiyoruz"dur. Tuketici cipleri (23andMe, AncestryDNA)
     *       panelin tamamini kapsamaz; 0 yazmak alel frekanslarini sistematik
     *       olarak asagi ceker ve GWAS sonuclarini bozar.
     *
     *       3 secilmesi BEDAVADIR: tablo zaten `dozaj == 0|1|2` sorularini
     *       soruyor. 3 hicbirine uymaz, dolayisiyla o katilimci O SNP'nin
     *       tablosuna hic girmez — istenen davranis tam olarak budur.
     *
     *       Kirpma da buna gore: arali disi bir deger (kotu niyetli 255 dahil)
     *       3'e kirpilir, yani "eksik" sayilir. Tabloyu bozmak yerine
     *       kendini disarida birakir.
     */
    uint8 public constant DOSAGE_MISSING = 3;

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
     * @notice Tek bir acilim talebinin kapsayabilecegi en fazla SNP.
     *
     * @dev SNP basina 6 handle kopyalanir ve her biri ACL yazimi gerektirir.
     *      Sinirsiz birakmak, buyuk panelde talebi blok gaz limitine
     *      carptirir — yani sinir zaten fiziksel; kodda acikca durmasi
     *      hatanin anlasilir olmasini saglar.
     */
    uint32 public constant MAX_DISCLOSURE_WINDOW = 32;

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
    mapping(uint32 snp => euint32[3][2]) private _contingency;

    /**
     * @notice Calismanin kapsadigi SNP sayisi.
     *
     * @dev  NEDEN SABIT KODLANMADI
     *
     *       Ilk surumde tablo TEK bir varyant icindi (`euint32[3][2]`). Gercek
     *       bir GWAS calismasi onlarca-binlerce varyant tarar; tek SNP'ye
     *       gomulu bir tasarim gercek veri geldiginde yeniden yazilmayi
     *       gerektirirdi.
     *
     *       Ilk katki geldikten SONRA degistirilemez: yarida degisen bir panel,
     *       kimi katilimcinin 10 kimi 50 SNP gonderdigi tutarsiz bir tablo
     *       birakirdi.
     */
    uint32 public snpCount;

    /**
     * @notice Katilimcinin sifreli grup etiketi (vaka/kontrol).
     *
     * @dev Bir kez kaydedilir ve tum partilerde yeniden kullanilir. Her partide
     *      tekrar gonderilseydi hem gereksiz maliyet olurdu hem de katilimcinin
     *      partiler arasinda grup degistirmesi mumkun hale gelirdi.
     */
    mapping(address => euint8) private _participantGroup;

    /// @notice Katilimci gruba kaydoldu mu (dozaj gondermeye hazir mi)?
    mapping(address => bool) public isEnrolled;

    /**
     * @notice Katilimcinin su ana kadar gonderdigi SNP sayisi.
     *
     * @dev Katkilar SIRALIDIR: bir sonraki parti tam olarak bu indeksten
     *      baslar. Boylece ne bosluk kalir ne de ayni SNP iki kez sayilir —
     *      ikisi de tabloyu sessizce bozardi.
     */
    mapping(address => uint32) public submittedSnps;

    /**
     * @notice Nadirlik bitinin hangi SNP'ye ait oldugu (rapor §4.3).
     *
     * @dev Cok SNP'li panelde "nadir tasiyici" sorusu bir varyanta ozgudur;
     *      hangisi oldugu acikca belirtilmelidir. Ilk katkidan sonra
     *      degistirilemez.
     */
    uint32 public rareSnpIndex;

    /**
     * @notice Calismanin varyant listesinin ozeti (keccak256).
     *
     * @dev  NEDEN ZORUNLU — sessiz bozulmayi onler
     *
     *       Zincir yalnizca SIRALI dozajlar gorur: `[d0, d1, ... dk]`. Bu
     *       dizinin hangi varyantlara karsilik geldigi zincirde YAZILI DEGILDIR.
     *
     *       Iki kullanici farkli dosyalar yukleyip farkli varyant siralari
     *       uretirse, "3 numarali SNP" biri icin rs1234 digeri icin rs9999
     *       olur ve kontenjans tablosu ALAKASIZ seyleri toplar. Tek
     *       kullaniciyla fark edilmez; ikinci gercek kullanicida sessizce
     *       bozulur.
     *
     *       Cozum: calisma bir PANEL tanimlar (sirali rsID + etki aleli
     *       listesi), ozeti buraya yazilir ve istemci dosyasini bu panele
     *       HIZALAR. Ozet, herkesin ayni listeyi kullandiginin kanitidir.
     *
     *       Panelin kendisi zincire yazilmaz (binlerce satir); IPFS'te durur
     *       ve `panelUri` ile isaret edilir.
     */
    bytes32 public panelHash;

    /// @notice Panel tanimina erisim adresi (IPFS CID ya da URL).
    string public panelUri;

    /// @dev SNP'nin kontenjans hucreleri baslatildi mi?
    mapping(uint32 => bool) private _snpInitialized;

    // ---------------------------------------------------------------------------------
    // Surekli biyobelirtec kanali (veri kategorisi 2) — AYRI MODUL
    // ---------------------------------------------------------------------------------

    /**
     * @notice Surekli olcum modulu (`VeriarfyBiomarkers`); 0 ise calisma
     *         yalnizca genomiktir.
     *
     * @dev  NEDEN AYRI KONTRAT — EIP-170
     *
     *       Metrik kanali bu kontrata eklendiginde derlenmis boyut 26.299
     *       bayta cikti; EIP-170 siniri 24.576'dir. Yani kontrat DAGITILAMAZ
     *       hale geldi. Optimizasyon ayarlari yetmedi (`runs: 1` ile 26.507,
     *       `viaIR` ile 28.483 — daha kotu) ve kod kutuphaneye tasimak da
     *       yetmedi: `delegatecall` icin gereken ABI kodlamasi, tasinan kodun
     *       kendisi kadar yer tutuyor.
     *
     *       Ayrim ayrica DOGRU olan: veri kategorileri birbirinden bagimsiz
     *       kanallardir ve her yeni kategori (3: klinik etiketler) ayni duvara
     *       carpardi. Onay/acilim dongusu TEK yerde — burada — kalir; modul
     *       yalnizca veriyi tutar.
     */
    address public biomarkerModule;


    // ---------------------------------------------------------------------------------
    // Nadirlik Carpani — rapor §4.3
    // ---------------------------------------------------------------------------------

    /**
     * @notice Nadir tasiyiciligi temsil eden dozaj seviyesi.
     *
     * @dev Rapor §4.3 sunu yaziyor: `ebool result = TFHE.eq(patient_SNP,
     *      SMA_mutant_code)`. Bizim dozaj olcegimizde (0/1/2 = tasinan minor
     *      allel sayisi) bunun karsiligi HOMOZIGOT MUTANT, yani 2'dir.
     *      Heterozigot (1) tasiyicilar cok daha yaygindir ve nadirlik
     *      primini hak etmez.
     */
    uint8 public constant RARE_DOSAGE = 2;

    /**
     * @notice "Kurucu Katkici" siniri — rapor §4.3: ilk 10.000 veri saglayici.
     * @dev Bonus kalicidir; carpani `VeriarfyPayments` uygular (+%50).
     */
    uint32 public constant FOUNDING_CONTRIBUTOR_LIMIT = 10_000;

    /**
     * @notice Katilimcinin sifreli nadirlik biti (`dozaj == RARE_DOSAGE`).
     *
     * @dev Bu bit `aggregateDosage` sirasinda ZATEN hesaplanan
     *      `FHE.eq(dosage, 2)` karsilastirmasindan alinir — ek FHE maliyeti
     *      yoktur. Sifreli kalir; yalnizca katilimci `requestRarityAssessment`
     *      derse acilabilir hale gelir.
     */
    mapping(address => ebool) private _rarityBit;

    /// @notice Katilimci nadirlik degerlendirmesini baslatti mi?
    mapping(address => bool) public rarityRequested;

    /**
     * @notice Katilimci nadir varyant tasiyicisi mi (KMS esigiyle dogrulandi).
     *
     * @dev  BILINCLI VE KACINILMAZ IFSA
     *
     *       Bu alan HERKESE ACIKTIR ve "bu adres nadir varyant tasiyor"
     *       bilgisini sizdirir. Bu bir uygulama hatasi degil, rapor §4.3'un
     *       ekonomisinin dogrudan sonucudur: nadirlik carpani odemeye
     *       yansidigi anda, 11 kat pay alan bir adresin tasiyici oldugu zaten
     *       zincirden okunur. Alani gizli tutmak yalnizca yanilsama yaratirdi.
     *
     *       Bu yuzden degerlendirme OTOMATIK DEGIL, katilimcinin acik
     *       cagrisiyla (`requestRarityAssessment`) baslar: tek bitlik ifsa ile
     *       yuksek gelir arasindaki takasi katilimci kendisi secer.
     *       Degerlendirme istenmezse carpan 1x kalir ve bit sifreli kalir.
     *
     *       Ifsa edilen sey TEK BITTIR: genomun kendisi, panel, hatta dozajin
     *       0 mi 1 mi oldugu acilmaz.
     */
    mapping(address => bool) public isRareCarrier;

    /// @notice Nadirlik biti hangi blokta dogrulandi (0 = dogrulanmadi).
    mapping(address => uint256) public rarityConfirmedAtBlock;

    /// @notice Havuzdaki dogrulanmis nadir tasiyici sayisi (`N_variant`).
    uint32 public rareCarrierCount;

    /**
     * @notice Izin ANINDA katilimcinin nadirlik durumu.
     *
     * @dev  NEDEN DONDURULUYOR
     *
     *       Odeme sozlesmesi payi O(1) hesaplayabilmek icin arastirmaci basina
     *       "kac tasiyici izin verdi" sayaclarini tutar. Katilimcinin durumu
     *       izin verdikten SONRA degisirse, bu sayaclar ile bireysel agirlik
     *       birbirini tutmaz ve havuz asilir. Durumu izin aninda dondurmak
     *       ikisini tanim geregi esitler.
     *
     *       Sonradan tasiyici oldugu dogrulanan bir katilimci, izni yenileyerek
     *       (iptal + yeniden izin) yeni agirligiyla sayilir.
     */
    mapping(address participant => mapping(address researcher => bool)) public rareAtGrant;

    /// @notice Bu arastirmaciya izin veren nadir tasiyici sayisi.
    mapping(address researcher => uint32) public consentRareCount;

    /// @notice Bu arastirmaciya izin veren Kurucu Katkici sayisi.
    mapping(address researcher => uint32) public consentFoundingCount;

    /// @notice Hem nadir tasiyici hem Kurucu Katkici olan izin verenler.
    mapping(address researcher => uint32) public consentRareFoundingCount;

    // ---------------------------------------------------------------------------------
    // BSKK-44 — yetkili dugumler ve esikli erisim
    // ---------------------------------------------------------------------------------

    /// @notice Konsensus uyesi dugumler.
    mapping(address => bool) public isAuthorizedNode;

    /**
     * @notice Kripto-ekonomik guvenlik modulu (rapor §2.7).
     *
     * @dev Atanmissa, onay verebilmek icin dugumun YETERLI TEMINATI olmasi
     *      gerekir; atanmamissa yetkilendirme tek basina yeter. Bos
     *      birakilabilir olmasi bilincli: modul olmadan da protokol calisir,
     *      yalnizca ekonomik caydiricilik olmaz.
     */
    address public stakingModule;

    // ---------------------------------------------------------------------------------
    // Dead Man's Switch — varis dugumler (rapor §2.6.1)
    // ---------------------------------------------------------------------------------

    /**
     * @notice Varis (fallback) dugumler — ana dugumler susarsa yetki bunlara gecer.
     *
     * @dev Varis olmak yetki VERMEZ; yalnizca devir halinde yetki dogar. Ana
     *      dugum ile varis ayni adres olmamalidir, ama kod bunu zorlamaz:
     *      kurumsal yapida ayni kurumun iki ayri tesisi varis olabilir.
     */
    mapping(address => bool) public isHeirNode;

    /// @notice Varis dugum sayisi.
    uint256 public heirNodeCount;

    /**
     * @notice Ana dugumlerden gelen SON yasam isaretinin blogu.
     *
     * @dev  NEDEN TEK SAYAC, DUGUM BASINA DEGIL
     *
     *       Rapor "ana dugumlerin belirli bir sure yanit vermemesi" diyor —
     *       yani TAMAMININ susmasi. Bir dugum bile hayattaysa ag ayakta
     *       demektir. Tek sayac bu tanimi birebir karsilar ve kontrolu O(1)
     *       yapar; dugum basina zaman damgasi tutmak, devir kontrolunde tum
     *       listeyi dolasmayi gerektirirdi.
     *
     *       Hem `heartbeat()` hem de gercek is (`approveDisclosure`) bu
     *       sayaci gunceller: calisan bir dugumun ayrica "hayattayim" demesi
     *       gerekmemelidir.
     */
    uint256 public lastMainHeartbeat;

    /**
     * @notice Sessizlik esigi (blok). 0 = Dead Man's Switch kapali.
     *
     * @dev Uretimde gunler mertebesinde olmalidir: kisa bir esik, gecici bir
     *      altyapi kesintisini "ele gecirildi" sanip yetkiyi gereksiz yere
     *      devrederdi.
     */
    uint256 public livenessTimeout;

    /**
     * @notice Yonetimin ELLE ilan ettigi devir.
     *
     * @dev  NEDEN GEREKLI — raporun kapatmadigi bosluk:
     *
     *       Sessizlik tespiti yalnizca dugumlerin SUSMASINI gorur. Rapor
     *       §2.6.1 mekanizmanin "ana dugumler dusman tarafindan hacklenirse"
     *       de devreye girdigini soyluyor; ama ele gecirilmis bir dugum
     *       susmaz — saldirgan yasam isareti gondermeye devam eder ve devri
     *       sonsuza kadar erteleyebilir.
     *
     *       Bu, sessizlik tabanli hicbir tasarimin cozemeyecegi bir sorundur.
     *       Ele gecirme durumu icin acik bir yonetisim karari gerekir; burada
     *       o karar ayri ve gorunur bir islemdir. Kendi kendine kalkmaz —
     *       yasam isareti gelmesi bunu temizlemez.
     */
    bool public failoverDeclared;

    /// @notice Varis esigi — rapor §2.6.1: 9/12.
    uint8 public constant HEIR_THRESHOLD_NUMERATOR = 9;
    uint8 public constant HEIR_THRESHOLD_DENOMINATOR = 12;

    /**
     * @notice Itiraz suresi (blok) — rapor §2.7.1 "Challenge Period".
     *
     * @dev Esige ulasan bir acilim, bu sure boyunca FIILEN verilmez. Sure
     *      dolmadan `executeDisclosure` reddedilir.
     *
     *      Varsayilan 0'dir: itiraz mekanizmasi kurulmadan once sureyi
     *      uygulamak, hicbir guvenlik kazanci saglamadan sistemi
     *      yavaslatirdi. `setChallengePeriod` ile acilir.
     */
    uint256 public challengePeriod;

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
        /**
         * @dev Devir halinde gecerli olacak esik (rapor §2.6.1).
         *
         * Talep aninda AYRICA hesaplanir. Sebep: devir, talep acildiktan
         * SONRA da olabilir. Tek esik saklansaydi, ana dugumler talep
         * asamasinda susarsa o talep sonsuza kadar onaylanamaz — havuz kalici
         * olarak erisilemez hale gelirdi.
         */
        uint32 heirRequiredApprovals;
        /// @dev Ana dugumlerden gelen onay sayisi.
        uint32 mainApprovals;
        /**
         * @dev Varis dugumlerden gelen onay sayisi — AYRI sayilir.
         *
         * Devir aninda ana dugumlerin onaylari varislerinkine EKLENMEZ:
         * devir zaten "ana dugumlere guvenilmiyor" demektir. Karistirmak,
         * ele gecirilmis dugumlerin biriktirdigi onaylarin varis esigini
         * doldurmasina izin verirdi.
         */
        uint32 heirApprovals;
        uint32 snapshotCount;
        uint64 requestedAt;
        /// @dev Esige ULASILDI mi? Tek basina cozum yetkisi VERMEZ (bkz. asagi).
        bool finalized;
        /**
         * @dev Itiraz suresinin BITTIGI blok — esige ulasildiginda hesaplanir.
         *
         * Rapor §2.7.1: coklu imza onayindan sonra bir "Itiraz Suresi"
         * (Challenge Period) baslar.
         *
         * Sure, baslangic blogu degil BITIS blogu olarak saklanir: sahip
         * `challengePeriod`'u sonradan degistirirse zaten acilmis taleplerin
         * penceresi kaymamalidir. Baslangici saklayip her okumada guncel
         * sureyi eklemek, gecmise donuk bir degisiklik anlamina gelirdi.
         */
        uint256 challengeEndsAtBlock;
        /**
         * @dev Cozum yetkisi GERCEKTEN verildi mi?
         *
         * Neden `finalized`'dan ayri: FHE erisim izni (`FHE.allow`) geri
         * ALINAMAZ. Bir kez verildikten sonra arastirmaci zincir disinda
         * aninda cozer; sonradan "itiraz kabul edildi" demek bir sey
         * degistirmez. Bu yuzden itiraz suresi izinden ONCE gelmek zorundadir.
         */
        bool executed;
        /// @dev Itiraz kabul edildi mi (bkz. `VeriarfyStaking`)?
        bool revoked;
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
         *
         * SINIRLI PENCERE: tum panelin goruntusu alinmaz. 1000 SNP'lik bir
         * panelde bu 6000 handle kopyasi demektir — hem gaz acisindan imkansiz
         * hem de gereksiz: bir arastirmaci genelde belirli varyantlarla
         * ilgilenir. Talep, ilgilendigi araligi bildirir ve yalnizca o aralik
         * dondurulur.
         */
        mapping(uint32 => euint32[3][2]) contingencySnapshot;
        /// @dev Goruntunun kapsadigi SNP araligi [snpFrom, snpTo).
        uint32 snpFrom;
        uint32 snpTo;
        /// @dev Goruntunun kapsadigi metrik araligi [metricFrom, metricTo).
        ///      Toplamlarin kendisi `biomarkerModule` icinde dondurulur.
        uint32 metricFrom;
        uint32 metricTo;
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
        // Varsayilan tek SNP: mevcut davranisla ayni. Cok varyantli calisma
        // icin `configurePanel` ile buyutulur (ilk katkidan ONCE).
        snpCount = 1;

        _dosagePool = FHE.asEuint32(0);
        FHE.allowThis(_dosagePool);

        // Kontenjans tablosu artik SNP basina ayri; kurucuda hepsini
        // baslatmak mumkun degil (panel binlerce olabilir). Hucreler ilk
        // dokunusta tembel baslatilir — bkz. `_ensureSnpInitialized`.
    }

    /**
     * @dev Bir SNP'nin 6 hucresini ilk kullanimda baslatir.
     *
     * fhEVM'de baslatilmamis bir `euint32` sifir HANDLE'idir, sifir DEGER
     * degil; uzerinde islem yapmak gecersizdir. Kurucuda tum paneli
     * baslatmak binlerce SNP'de imkansiz oldugu icin baslatma ilk katkiya
     * ertelenir. Maliyeti SNP basina bir kez odenir.
     */
    function _ensureSnpInitialized(uint32 snp) private {
        if (_snpInitialized[snp]) return;
        ContingencyStats.initialize(_contingency, snp);
        _snpInitialized[snp] = true;
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
        // Tek SNP'lik calismalarin kisayolu: kayit ve tek dozaj bir arada.
        // Cok SNP'li panelde anlamsizdir; cagiran `enroll` + `contributeDosages`
        // kullanmalidir.
        if (snpCount != 1) revert UseBatchApi(snpCount);

        _enroll(encGroup, inputProof);

        externalEuint8[] memory single = new externalEuint8[](1);
        single[0] = encDosage;
        _contribute(single, inputProof);
    }

    /**
     * @notice Katilimciyi vaka/kontrol grubuna sifreli olarak kaydeder.
     *
     * @dev Grup BIR KEZ yazilir ve tum partilerde yeniden kullanilir. Her
     *      partide tekrar gonderilseydi katilimci partiler arasinda grup
     *      degistirebilir ve tabloyu bozabilirdi.
     */
    function enroll(
        externalEuint8 encGroup,
        bytes calldata inputProof
    ) external nonReentrant {
        _enroll(encGroup, inputProof);
    }

    /**
     * @notice Bir sonraki SNP dilimi icin sifreli dozajlari gonderir.
     *
     * @dev  PARTILI OLMASININ SEBEBI GAZ.
     *
     *       SNP basina kontenjans tablosu ~23 FHE islemi ve olculen ~620.000
     *       gaz demektir. 1000 SNP tek islemde blok limitine sigmaz. Katilimci
     *       paneli kendi sectigi buyuklukte partiler halinde gonderir;
     *       sozlesme yalnizca SIRALILIGI zorlar.
     *
     *       Parti buyuklugunu cagiran secer cunku blok gaz limiti aga gore
     *       degisir; sozlesmeye gomulu bir sayi bir agda israf, digerinde
     *       basarisiz islem olurdu.
     *
     * @param encDosages Sirali dozaj dilimi; `submittedSnps[msg.sender]`
     *        indeksinden baslar.
     */
    function contributeDosages(
        externalEuint8[] calldata encDosages,
        bytes calldata inputProof
    ) external nonReentrant {
        externalEuint8[] memory copied = new externalEuint8[](encDosages.length);
        for (uint256 i = 0; i < encDosages.length; ++i) {
            copied[i] = encDosages[i];
        }
        _contribute(copied, inputProof);
    }

    function _enroll(externalEuint8 encGroup, bytes calldata inputProof) private {
        if (isEnrolled[msg.sender]) revert AlreadyEnrolled(msg.sender);

        euint8 group = FHE.fromExternal(encGroup, inputProof);
        // Butunluk: arali disi grup degerini sifreliyken kirp.
        group = FHE.min(group, FHE.asEuint8(GROUP_CASE));

        _participantGroup[msg.sender] = group;
        FHE.allowThis(group);

        // Modul, ayni sifreli grup etiketini KULLANABILMELIDIR.
        //
        // fhEVM'de erisim izni kontrat bazlidir: `VeriarfyBiomarkers` bu
        // handle uzerinde islem yapamazsa metrikleri gruplara ayiramaz. Izin
        // kayit aninda verilir cunku sonradan verilemez — katilimci ikinci bir
        // islem imzalamak zorunda kalirdi. Bu yuzden modul, ILK KAYITTAN ONCE
        // baglanmis olmak zorundadir; `setBiomarkerModule` bunu zorlar.
        if (biomarkerModule != address(0)) FHE.allow(group, biomarkerModule);

        isEnrolled[msg.sender] = true;

        // Panel ilk katkidan sonra degistirilemez.
        panelFrozen = true;

        emit Enrolled(msg.sender);
    }

    function _contribute(externalEuint8[] memory encDosages, bytes calldata inputProof) private {
        if (!isEnrolled[msg.sender]) revert NotEnrolled(msg.sender);
        if (encDosages.length == 0) revert EmptyBatch();

        uint32 start = submittedSnps[msg.sender];
        uint32 end = start + uint32(encDosages.length);
        if (end > snpCount) revert TooManySnps(end, snpCount);

        // Grup karsilastirmalari PARTI BASINA BIR KEZ yapilir; SNP basina
        // tekrarlanmasi gereksiz iki bootstrapping olurdu.
        euint8 group = _participantGroup[msg.sender];
        ebool[2] memory inGroup;
        inGroup[GROUP_CONTROL] = FHE.eq(group, GROUP_CONTROL);
        inGroup[GROUP_CASE] = FHE.eq(group, GROUP_CASE);

        for (uint256 i = 0; i < encDosages.length; ++i) {
            uint32 snp = start + uint32(i);

            _ensureSnpInitialized(snp);

            euint8 dosage = FHE.fromExternal(encDosages[i], inputProof);
            // Butunluk: arali disi degerleri sifreliyken kirp. Kotu niyetli bir
            // istemci 255 gonderip tablo ya da toplami bozamaz.
            // Kirpma `DOSAGE_MISSING`'e yapilir, `MAX_DOSAGE`'a degil:
            // arali disi deger tabloyu bozmak yerine "eksik" sayilir.
            dosage = FHE.min(dosage, FHE.asEuint8(DOSAGE_MISSING));

            _dosagePool = FHE.add(_dosagePool, dosage);
            FHE.allowThis(_dosagePool);

            // Kontenjans tablosu — ayrinti `ContingencyStats` icinde.
            //
            // Nadirlik biti (rapor §4.3) burada BEDAVA gelir: aranan
            // karsilastirma `dozaj == 2`, tablo icin zaten yapiliyor.
            // Yalnizca `rareSnpIndex` icin saklanir — cok SNP'li panelde
            // "nadir tasiyici" sorusu bir varyanta ozgudur.
            ebool isRare = ContingencyStats.accumulate(
                _contingency,
                snp,
                dosage,
                inGroup[GROUP_CONTROL],
                inGroup[GROUP_CASE],
                RARE_DOSAGE
            );

            if (snp == rareSnpIndex) {
                _rarityBit[msg.sender] = isRare;
                FHE.allowThis(isRare);
            }
        }

        submittedSnps[msg.sender] = end;
        emit DosagesContributed(msg.sender, start, end);

        // Katilimci ancak paneli TAMAMLAYINCA sayilir.
        //
        // Yarim kalan bir katki tabloya girmistir ama katilimci degildir:
        // k-anonimlik esigi ve gelir paylasimi eksik veriyi tam saymamalidir.
        if (end == snpCount) {
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
    }

    /**
     * @notice Calismanin SNP panelini yapilandirir (rapor §3.3).
     *
     * @dev  ILK KATKIDAN SONRA DEGISTIRILEMEZ.
     *
     *       Yarida degisen bir panel, kimi katilimcinin 10 kimi 50 SNP
     *       gonderdigi tutarsiz bir tablo birakirdi: sutun sayilari farkli
     *       kohortlardan gelir ve ki-kare anlamsizlasirdi.
     *
     * @param snpCount_     Panelin varyant sayisi.
     * @param rareSnpIndex_ Nadirlik Carpani'nin hangi varyanta ait oldugu.
     */
    function configurePanel(
        uint32 snpCount_,
        uint32 rareSnpIndex_,
        bytes32 panelHash_,
        string calldata panelUri_
    ) external onlyOwner {
        if (panelFrozen) revert PanelFrozen();
        if (snpCount_ == 0) revert InvalidSnpCount(snpCount_);
        if (rareSnpIndex_ >= snpCount_) revert InvalidSnpCount(rareSnpIndex_);

        snpCount = snpCount_;
        rareSnpIndex = rareSnpIndex_;
        panelHash = panelHash_;
        panelUri = panelUri_;

        emit PanelConfigured(snpCount_, rareSnpIndex_, panelHash_, panelUri_);
    }

    /// @notice Katilimci paneli TAMAMLADI mi?
    function hasAggregated(address participant) public view returns (bool) {
        return submittedSnps[participant] == snpCount && isEnrolled[participant];
    }

    /**
     * @notice Katilimcinin SIFRELI grup etiketinin handle'i.
     *
     * @dev Modul bunu okur. Handle'i gormek bir sey aciga cikarmaz: cozum yine
     *      ACL iznine baglidir ve o izin yalnizca kayit aninda module verilir.
     */
    function participantGroup(address participant) external view returns (euint8) {
        return _participantGroup[participant];
    }

    /**
     * @notice Surekli olcum modulunu baglar.
     *
     * @dev  ILK KAYITTAN ONCE cagrilmak ZORUNDADIR ve bir kez baglanan modul
     *       degistirilemez.
     *
     *       Sebep `_enroll` icinde anlatiliyor: sifreli grup etiketinin
     *       kullanim izni kayit aninda verilir. Modul sonradan baglansaydi,
     *       once kaydolmus katilimcilarin etiketini kullanamaz ve o
     *       katilimcilar metrik gonderemezdi — sessiz, kismi bir bozulma.
     *       Degistirilebilseydi ayni sorun tersine olurdu: eski modulun
     *       biriktirdigi toplamlar erisilemez kalirdi.
     */
    function setBiomarkerModule(address module) external onlyOwner {
        if (biomarkerModule != address(0)) revert ModuleAlreadyLocked();
        if (module == address(0)) revert ZeroAddress();
        if (panelFrozen) revert PanelFrozen();

        biomarkerModule = module;
        emit BiomarkerModuleUpdated(module);
    }

    /// @dev Varsayilan metrik penceresi: modul yoksa 0, varsa tavana kadar.
    function _defaultMetricWindow() private view returns (uint32) {
        if (biomarkerModule == address(0)) return 0;
        return IVeriarfyBiomarkers(biomarkerModule).disclosureWindowSize();
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

        // Nadirlik/kuruculuk durumu izin aninda DONDURULUR; gerekcesi
        // `rareAtGrant` aciklamasinda. Sayaclar ile bireysel agirlik ayni
        // kaynaktan beslenir, boylece dagitim havuzu asla asilamaz.
        bool rare = isRareCarrier[msg.sender];
        bool founding = isFoundingContributor(msg.sender);
        rareAtGrant[msg.sender][researcher] = rare;

        consentCount[researcher] += 1;
        if (rare) consentRareCount[researcher] += 1;
        if (founding) consentFoundingCount[researcher] += 1;
        if (rare && founding) consentRareFoundingCount[researcher] += 1;

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

        // Sayaclardan dusulen degerler, IZIN ANINDA dondurulan duruma gore
        // secilir — guncel duruma gore dusulseydi, arada nadirligi dogrulanan
        // bir katilimci sayaci eksiye dusurebilirdi.
        bool rare = rareAtGrant[msg.sender][researcher];
        bool founding = isFoundingContributor(msg.sender);

        consentCount[researcher] -= 1;
        if (rare) consentRareCount[researcher] -= 1;
        if (founding) consentFoundingCount[researcher] -= 1;
        if (rare && founding) consentRareFoundingCount[researcher] -= 1;

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
    // 3) Nadirlik Carpani — rapor §4.3
    // ---------------------------------------------------------------------------------

    /**
     * @notice Kurucu Katkici mi (ilk `FOUNDING_CONTRIBUTOR_LIMIT` saglayici)?
     * @dev Indeks 1 tabanlidir; 0 "katilimci degil" demektir.
     */
    function isFoundingContributor(address account) public view returns (bool) {
        uint32 index = participantIndex[account];
        return index != 0 && index <= FOUNDING_CONTRIBUTOR_LIMIT;
    }

    /**
     * @notice Sifreli nadirlik bitinin esikli cozumune izin verir.
     *
     * @dev  Rapor §4.3: "KMS dugumleri, hastanin tum genomunu degil, yalnizca
     *       bu tek bitlik boolean sonucunu threshold decryption ile cozer."
     *
     *       Bu cagri BITI ACMAZ; yalnizca acilabilir kilar. Gercek cozum
     *       KMS dugumlerinin esigini gerektirir ve zincir disinda olur.
     *       Cagriyi KATILIMCININ KENDISI yapar — ifsa takasi onun secimidir
     *       (bkz. `isRareCarrier` aciklamasi).
     *
     *       Donen `handle` ile relayer'a `publicDecrypt([handle])` cagrilir;
     *       sonuc ve KMS imzalari `confirmRarity` ile zincire geri yazilir.
     */
    function requestRarityAssessment() external nonReentrant returns (bytes32 handle) {
        if (!hasAggregated(msg.sender)) revert NotAParticipant(msg.sender);
        if (rarityRequested[msg.sender]) revert RarityAlreadyRequested(msg.sender);

        rarityRequested[msg.sender] = true;

        ebool bit = _rarityBit[msg.sender];
        FHE.makePubliclyDecryptable(bit);

        handle = ebool.unwrap(bit);
        emit RarityAssessmentRequested(msg.sender, handle);
    }

    /**
     * @notice Esikli cozulmus nadirlik bitini zincire yazar.
     *
     * @dev  HERKES CAGIRABILIR — ve bu guvenlik acigi DEGIL, tasarimdir.
     *
     *       Sonucun dogrulugu cagiranin durustluguna degil, KMS dugumlerinin
     *       EIP-712 imzalarina baglidir: `verifyDecryptionEIP712KMSSignatures`
     *       "bu handle bu degere cozulur" iddiasini zincirde dogrular. Yanlis
     *       bir deger imzalanamayacagi icin sonucu kimin tasidigi onemsizdir.
     *
     *       Rapor §4.3 "sonuc 1 ise kullaniciya Nadirlik Carpani OTOMATIK
     *       tanimlanir" diyor. fhEVM 0.11.x'te sozlesmeye geri donen bir oracle
     *       geri cagrisi bulunmadigindan (bkz. `IKMSVerifier`), otomatiklik
     *       "izinsiz/permissionless" olmakla saglanir: tanimayi baslatmak icin
     *       ayricalikli bir role gerek yoktur.
     *
     *       Tek yonlu: bir kez dogrulanan bit degistirilemez. Dozaj da
     *       degistirilemedigi icin (`AlreadyAggregated`) yeniden degerlendirme
     *       anlamsizdir.
     *
     * @param participant     Biti dogrulanacak katilimci.
     * @param decryptedResult Duz sonucun ABI kodlamasi (`abi.encode(bool)`).
     * @param decryptionProof KMS dugumlerinin imzalari.
     */
    function confirmRarity(
        address participant,
        bytes calldata decryptedResult,
        bytes calldata decryptionProof
    ) external nonReentrant {
        if (!rarityRequested[participant]) revert RarityNotRequested(participant);
        if (rarityConfirmedAtBlock[participant] != 0) {
            revert RarityAlreadyConfirmed(participant);
        }

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = ebool.unwrap(_rarityBit[participant]);

        IKMSVerifier kms = IKMSVerifier(
            ZamaConfig.getEthereumCoprocessorConfig().KMSVerifierAddress
        );
        if (!kms.verifyDecryptionEIP712KMSSignatures(handles, decryptedResult, decryptionProof)) {
            revert InvalidDecryptionProof(participant);
        }

        bool rare = abi.decode(decryptedResult, (bool));

        rarityConfirmedAtBlock[participant] = block.number;
        if (rare) {
            isRareCarrier[participant] = true;
            rareCarrierCount += 1;
        }

        emit RarityConfirmed(participant, rare, rareCarrierCount);
    }

    /**
     * @notice Nadirlik carpaninin paydasi ve payi — `R = log2(1 + N/C)` girdisi.
     *
     * @dev Odeme sozlesmesi bunu sorgu aninda anlik goruntuye alir. Rapor §4.3
     *      `N_total`'i HAVUZUN TAMAMI olarak tanimlar (izin verenler degil):
     *      nadirlik, varyantin populasyondaki gercek seyrekligidir.
     */
    function rarityStats() external view returns (uint32 poolCount, uint32 carriers) {
        return (participantCount, rareCarrierCount);
    }

    /// @notice Sifreli nadirlik handle'i (cozmek ayri yetkidir).
    function rarityHandle(address participant) external view returns (bytes32) {
        return ebool.unwrap(_rarityBit[participant]);
    }

    // ---------------------------------------------------------------------------------
    // 4) Yetkili dugum yonetimi
    // ---------------------------------------------------------------------------------

    function authorizeNode(address node) external onlyOwner {
        if (node == address(0)) revert ZeroAddress();
        if (isAuthorizedNode[node]) revert AlreadyAuthorized(node);

        isAuthorizedNode[node] = true;
        authorizedNodeCount += 1;

        // Yeni bir ana dugum katilmasi da bir yasam isaretidir. Bu satir
        // olmasaydi, ilk dugum atandiginda sayac 0 kalir ve sessizlik esigi
        // aciksa devir DERHAL tetiklenirdi.
        lastMainHeartbeat = block.number;

        emit NodeAuthorized(node);
    }

    function revokeNode(address node) external {
        // Sahip DISINDA tek yetkili, kripto-ekonomik guvenlik moduludur:
        // kesilen (slash edilen) bir dugumun yetkisi de dusmelidir, yoksa
        // teminatsiz kalan dugum onay vermeye devam edebilirdi. Bu adimi
        // sahibin elle yapmasina birakmak, cezayi insafa baglardi.
        if (msg.sender != owner() && msg.sender != stakingModule) {
            revert NotStakingModule(msg.sender);
        }
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
        // Varsayilan pencere: panelin basindan, tavana kadar. Tek SNP'lik
        // calismalarda eski davranisla birebir ayni.
        uint32 window = snpCount > MAX_DISCLOSURE_WINDOW ? MAX_DISCLOSURE_WINDOW : snpCount;

        // Metrik paneli varsa varsayilan olarak o da tavana kadar acilir;
        // yoksa (modul yok) aralik bostur ve modul hic cagrilmaz.
        uint32 metricWindow = _defaultMetricWindow();

        return _requestDisclosure(researcher, queryType, 0, window, 0, metricWindow);
    }

    /**
     * @notice Acilim talebini belirli bir METRIK araligi icin acar.
     *
     * @dev SNP penceresiyle ayni gerekce: arastirmaci genelde birkac metrikle
     *      ilgilenir ve ne kadar az acilirsa gizlilik o kadar korunur.
     */
    function requestDisclosureMetrics(
        address researcher,
        uint8 queryType,
        uint32 snpFrom,
        uint32 snpWindow,
        uint32 metricFrom,
        uint32 metricWindow
    ) external nonReentrant returns (uint256 requestId) {
        return
            _requestDisclosure(
                researcher,
                queryType,
                snpFrom,
                snpWindow,
                metricFrom,
                metricWindow
            );
    }

    /**
     * @notice Acilim talebini BELIRLI bir SNP araligi icin acar.
     *
     * @dev Cok varyantli panellerde arastirmaci genelde birkac SNP ile
     *      ilgilenir; tum paneli cozdurmek hem gereksiz hem de gizlilik
     *      acisindan savurgandir (ne kadar az acilirsa o kadar iyi).
     *
     * @param snpFrom   Aralik basi (dahil).
     * @param snpWindow Aralik uzunlugu; en fazla `MAX_DISCLOSURE_WINDOW`.
     */
    function requestDisclosureWindow(
        address researcher,
        uint8 queryType,
        uint32 snpFrom,
        uint32 snpWindow
    ) external nonReentrant returns (uint256 requestId) {
        uint32 metricWindow = _defaultMetricWindow();
        return _requestDisclosure(researcher, queryType, snpFrom, snpWindow, 0, metricWindow);
    }

    function _requestDisclosure(
        address researcher,
        uint8 queryType,
        uint32 snpFrom,
        uint32 snpWindow,
        uint32 metricFrom,
        uint32 metricWindow
    ) private returns (uint256 requestId) {
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
        // Devir esigi de SIMDI dondurulur; gerekcesi alanin aciklamasinda.
        // Varis atanmamissa 0 kalir ve devir zaten mumkun olmaz.
        request.heirRequiredApprovals = heirNodeCount == 0
            ? 0
            : heirRequiredApprovals(queryType);
        request.snapshotCount = participantCount;
        request.requestedAt = uint64(block.timestamp);
        request.snapshot = _dosagePool;

        // Anlik goruntu ayri bir handle olarak yasayacagi icin kontratin ona
        // erisim izni de ayrica verilmelidir.
        FHE.allowThis(request.snapshot);

        // Kontenjans tablosu da dondurulur — GWAS'in ki-kare girdisi budur.
        //
        // Yalnizca ISTENEN ARALIK kopyalanir. Tum panel kopyalansaydi 1000
        // SNP'de 6000 handle yazimi olurdu: gaz acisindan imkansiz ve
        // gereksiz, cunku arastirmaci belirli varyantlarla ilgilenir.
        uint32 windowEnd = snpFrom + snpWindow;
        if (windowEnd > snpCount) revert TooManySnps(windowEnd, snpCount);
        if (snpWindow == 0 || snpWindow > MAX_DISCLOSURE_WINDOW) {
            revert InvalidSnpWindow(snpWindow, MAX_DISCLOSURE_WINDOW);
        }

        request.snpFrom = snpFrom;
        request.snpTo = windowEnd;

        for (uint32 snp = snpFrom; snp < windowEnd; ++snp) {
            ContingencyStats.snapshot(_contingency, request.contingencySnapshot, snp);
        }

        // Biyobelirtec toplamlari da ayni anda dondurulur.
        //
        // `metricWindow == 0` gecerlidir ve "bu talep metrik istemiyor"
        // demektir — yalnizca genomik calismalarda (metrik paneli yok) ve
        // arastirmacinin sadece GWAS istedigi durumlarda olur. SNP penceresi
        // icin ayni sey gecerli DEGILDIR: orada 0 pencere anlamsizdir cunku
        // her calismanin en az bir SNP'si vardir.
        uint32 metricEnd = metricFrom + metricWindow;
        if (metricWindow > 0 && biomarkerModule == address(0)) {
            revert InvalidMetricWindow(metricWindow, 0);
        }

        request.metricFrom = metricFrom;
        request.metricTo = metricEnd;

        if (metricEnd > metricFrom) {
            IVeriarfyBiomarkers(biomarkerModule).snapshotFor(requestId, metricFrom, metricEnd);
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

    /**
     * @notice Devir halinde gereken varis onayi sayisi (rapor §2.6.1: 9/12).
     *
     * @dev  IKI KURALIN BUYUGU ALINIR.
     *
     *       Rapor devir esigini tek bir oran olarak veriyor (9/12 = %75) ama
     *       §2.6'daki kademeli esikler de yururlukte: populasyon genetigi
     *       sorgusu 9/10 = %90 ister. Yalnizca 9/12 uygulansaydi, en hassas
     *       sorgu KRIZ ANINDA daha KOLAY gecerdi — mekanizmanin amacinin tam
     *       tersi. Bu yuzden iki esikten buyugu gecerlidir.
     */
    function heirRequiredApprovals(uint8 queryType) public view returns (uint32) {
        uint8 fraction = thresholdFraction[queryType];
        if (fraction == 0) revert UnknownQueryType(queryType);

        uint256 heirs = heirNodeCount;
        if (heirs == 0) revert NoHeirNodes();

        uint256 crisis = (heirs * HEIR_THRESHOLD_NUMERATOR + HEIR_THRESHOLD_DENOMINATOR - 1) /
            HEIR_THRESHOLD_DENOMINATOR;
        uint256 graded = (heirs * fraction + THRESHOLD_DENOMINATOR - 1) / THRESHOLD_DENOMINATOR;

        uint256 required = crisis > graded ? crisis : graded;
        return uint32(required == 0 ? 1 : required);
    }

    /**
     * @notice Yetki su anda varis dugumlerde mi (rapor §2.6.1)?
     *
     * @dev Iki yoldan biriyle aktiflesir:
     *      1. ana dugumler `livenessTimeout` boyunca SUSTU (otomatik),
     *      2. yonetim devri ELLE ilan etti (ele gecirme hali).
     *
     *      Varis atanmamissa devir olmaz: yetkiyi kimsenin olmadigi bir
     *      kumeye devretmek havuzu kalici olarak kilitlerdi.
     */
    function isFailoverActive() public view returns (bool) {
        if (heirNodeCount == 0) return false;
        if (failoverDeclared) return true;
        if (livenessTimeout == 0) return false;
        return block.number > lastMainHeartbeat + livenessTimeout;
    }

    /**
     * @notice Ana dugumun yasam isareti.
     *
     * @dev Gercek is de (onay vermek) ayni sayaci gunceller; bu cagri, uzun
     *      sure sorgu gelmeyen donemlerde agin ayakta oldugunu gostermek
     *      icindir.
     */
    function heartbeat() external onlyAuthorizedNode {
        lastMainHeartbeat = block.number;
        emit Heartbeat(msg.sender, block.number);
    }

    /// @notice Varis dugum atar (rapor §2.6.1 "Fallback Nodes").
    function authorizeHeirNode(address node) external onlyOwner {
        if (node == address(0)) revert ZeroAddress();
        if (isHeirNode[node]) revert AlreadyAuthorized(node);

        isHeirNode[node] = true;
        heirNodeCount += 1;
        emit HeirNodeAuthorized(node);
    }

    function revokeHeirNode(address node) external onlyOwner {
        if (!isHeirNode[node]) revert NotAuthorized(node);

        isHeirNode[node] = false;
        heirNodeCount -= 1;
        emit HeirNodeRevoked(node);
    }

    /// @notice Sessizlik esigini ayarlar; 0 = Dead Man's Switch kapali.
    function setLivenessTimeout(uint256 blocks) external onlyOwner {
        livenessTimeout = blocks;
        // Sayaci simdiye cek: aksi halde esik ilk kez acildiginda gecmisteki
        // sifir degeri yuzunden devir ANINDA tetiklenirdi.
        lastMainHeartbeat = block.number;
        emit LivenessTimeoutUpdated(blocks);
    }

    /**
     * @notice Devri elle ilan eder — ele gecirme hali (rapor §2.6.1).
     * @dev Yasam isareti gelmesi bunu TEMIZLEMEZ; yalnizca `clearFailover`.
     */
    function declareFailover() external onlyOwner {
        if (heirNodeCount == 0) revert NoHeirNodes();
        failoverDeclared = true;
        emit FailoverDeclared(block.number);
    }

    /// @notice Elle ilan edilen devri kaldirir ve yasam sayacini sifirlar.
    function clearFailover() external onlyOwner {
        failoverDeclared = false;
        lastMainHeartbeat = block.number;
        emit FailoverCleared(block.number);
    }

    /// @notice Sorgu kapisini belirler (odeme sozlesmesi).
    function setQueryGateway(address gateway) external onlyOwner {
        if (gateway == address(0)) revert ZeroAddress();
        queryGateway = gateway;
        emit QueryGatewayUpdated(gateway);
    }

    /// @notice Kripto-ekonomik guvenlik modulunu baglar (rapor §2.7).
    function setStakingModule(address module) external onlyOwner {
        stakingModule = module; // sifir adres: modulu devre disi birakir
        emit StakingModuleUpdated(module);
    }

    /**
     * @notice Itiraz suresini blok cinsinden ayarlar (rapor §2.7.1).
     *
     * @dev Sure UZUN olmali ki dogrulayicilar inceleyebilsin, ama sonsuz
     *      olmamali ki arastirmaci rehin kalmasin. Zaten acilmis taleplerin
     *      suresi degismez: `executeDisclosure` her cagrildiginda guncel
     *      degeri okur, bu yuzden ayar yalnizca ileriye donuk uygulanmalidir —
     *      bu nedenle yalnizca sahip degistirebilir ve degisiklik olay olarak
     *      yayilir.
     */
    function setChallengePeriod(uint256 blocks) external onlyOwner {
        challengePeriod = blocks;
        emit ChallengePeriodUpdated(blocks);
    }

    /**
     * @notice Cozum yetkisi FIILEN verildi mi?
     *
     * @dev Esige ulasmak yetmez: itiraz suresi de dolmus ve
     *      `executeDisclosure` cagrilmis olmalidir. Odeme sozlesmesi ucreti
     *      buna bakarak dagitima acar — yani para, sonuc gercekten teslim
     *      edildiginde el degistirir.
     */
    function isDisclosureGranted(uint256 requestId) external view returns (bool) {
        return _requests[requestId].executed;
    }

    /// @notice Esik saglandi mi (itiraz suresi henuz surebilir)?
    function isDisclosureFinalized(uint256 requestId) external view returns (bool) {
        return _requests[requestId].finalized;
    }

    /// @notice Itiraz suresinin bittigi blok (0 = esige henuz ulasilmadi).
    function challengeWindowEnd(uint256 requestId) external view returns (uint256) {
        return _requests[requestId].challengeEndsAtBlock;
    }

    /// @notice Itiraz kabul edildigi icin iptal edilmis mi?
    function isDisclosureRevoked(uint256 requestId) external view returns (bool) {
        return _requests[requestId].revoked;
    }

    /**
     * @notice Talebi onaylar; esige ulasilinca itiraz suresi baslar.
     *
     * @dev  KIM ONAYLAYABILIR, DEVIR DURUMUNA BAGLIDIR (rapor §2.6.1):
     *
     *       - normal halde  -> yalnizca ANA dugumler
     *       - devir halinde -> yalnizca VARIS dugumler
     *
     *       Devir halinde ana dugumlerin onay verememesi mekanizmanin
     *       ozudur: devir zaten "ana dugumlere guvenilmiyor" demektir.
     */
    function approveDisclosure(uint256 requestId) external nonReentrant {
        DisclosureRequest storage request = _requests[requestId];
        if (request.requester == address(0)) revert UnknownRequest(requestId);
        if (request.finalized) revert AlreadyFinalized(requestId);
        if (hasApproved[requestId][msg.sender]) revert AlreadyApproved(requestId, msg.sender);

        bool failover = isFailoverActive();

        if (failover) {
            if (!isHeirNode[msg.sender]) revert NotHeirNode(msg.sender);
            // Devir talep acilmadan once yoktu ve varis esigi hesaplanmadiysa
            // bu talep varislerce sonuclandirilamaz; yeni talep acilmalidir.
            if (request.heirRequiredApprovals == 0) revert NoHeirNodes();
        } else {
            if (!isAuthorizedNode[msg.sender]) revert NotAuthorizedNode(msg.sender);
            // Onay vermek yasam isaretidir: calisan bir dugumun ayrica
            // "hayattayim" demesi gerekmemelidir.
            lastMainHeartbeat = block.number;
        }

        // Rapor §2.7: onay vermek EKONOMIK SORUMLULUK gerektirir. Modul
        // atanmissa teminati yetersiz dugum oy kullanamaz — aksi halde
        // slashing'in yaptirim gucu olmazdi. Varis dugumler de bu kurala
        // tabidir; kriz ani sorumsuzlugu mesrulastirmaz.
        if (stakingModule != address(0) && !IVeriarfyStaking(stakingModule).canApprove(msg.sender)) {
            revert NodeNotStaked(msg.sender);
        }

        _approve(requestId, request, failover);
    }

    /**
     * @dev Onayi kaydeder; esik saglandiysa **onaylayan her dugume** anlik
     *      goruntuyu cozme izni verir.
     *
     *      Izin yalnizca onaylayanlara verilir: cozum yetkisi kolektif kararin
     *      sonucudur, tek bir talep sahibinin odulu degil.
     */
    function _approve(
        uint256 requestId,
        DisclosureRequest storage request,
        bool failover
    ) private {
        hasApproved[requestId][msg.sender] = true;
        request.approvers.push(msg.sender);

        // Iki sayac AYRI tutulur: devir halinde ana dugumlerin daha once
        // biriktirdigi onaylar varis esigine sayilmaz (bkz. alan aciklamasi).
        uint256 approvals;
        uint32 required;

        if (failover) {
            request.heirApprovals += 1;
            approvals = request.heirApprovals;
            required = request.heirRequiredApprovals;
        } else {
            request.mainApprovals += 1;
            approvals = request.mainApprovals;
            required = request.requiredApprovals;
        }

        emit DisclosureApproved(requestId, msg.sender, approvals);

        // Esik, TALEP ANINDA sorgu tipine gore sabitlenmistir (rapor §2.6).
        if (approvals < required) return;

        // Esik saglandi — ama cozum yetkisi HENUZ VERILMEZ.
        //
        // Rapor §2.7.1: coklu imza onayindan sonra bir Itiraz Suresi baslar.
        // Izin bu noktada verilseydi itiraz suresi susleme olurdu: `FHE.allow`
        // geri alinamaz ve arastirmaci zincir disinda aninda cozerdi.
        request.finalized = true;
        request.challengeEndsAtBlock = block.number + challengePeriod;

        emit DisclosureFinalized(requestId, request.challengeEndsAtBlock);
    }

    /**
     * @notice Itiraz suresi dolduktan sonra cozum yetkisini FIILEN verir.
     *
     * @dev  Herkes cagirabilir: sartlarin tamami zincirde gorunur olgulardir
     *       (esik saglandi, sure doldu, itiraz kabul edilmedi). Yetkinin
     *       verilmesini birinin insafina birakmak, arastirmaciyi rehin
     *       birakirdi.
     *
     *       `isDisclosureGranted` bu adimdan SONRA true doner; odeme
     *       sozlesmesi de ucreti ancak o zaman dagitima acar. Yani para,
     *       sonuc gercekten teslim edildiginde el degistirir.
     */
    function executeDisclosure(uint256 requestId) external nonReentrant {
        DisclosureRequest storage request = _requests[requestId];
        if (request.requester == address(0)) revert UnknownRequest(requestId);
        if (!request.finalized) revert NotFinalized(requestId);
        if (request.revoked) revert DisclosureRevoked(requestId);
        if (request.executed) revert AlreadyFinalized(requestId);

        if (block.number < request.challengeEndsAtBlock) {
            revert ChallengePeriodOpen(requestId, request.challengeEndsAtBlock);
        }

        // Sure dolmus olsa bile COZULMEMIS bir itiraz varsa yetki verilmez.
        //
        // Bu kontrol sart: itiraz, surenin son blogunda acilabilir ve oylamasi
        // surenin otesine tasar. Yalnizca sureye bakilsaydi, itiraz edilen bir
        // acilim oylama daha bitmeden yurutulur ve `FHE.allow` geri
        // alinamayacagi icin itiraz anlamsizlasirdi.
        if (stakingModule != address(0) && IVeriarfyStaking(stakingModule).isBlocked(requestId)) {
            revert ChallengeUnresolved(requestId);
        }

        request.executed = true;

        // Cozum yetkisi ARASTIRMACIYA verilir — rapor §2.5.2 adim 6:
        // "Cozulen sonuc yalnizca arastirmacinin cuzdan adresine iletilir."
        //
        // Onceki surumde izin onaylayan dugumlere veriliyordu; bu, onaylayan
        // her kurumun sonucu gormesi demekti ve raporun akisiyla celisiyordu.
        FHE.allow(request.snapshot, request.requester);

        // Ki-kare icin her SNP'nin 6 hucresi cozulebilmeli; tek tek izin verilir.
        for (uint32 snp = request.snpFrom; snp < request.snpTo; ++snp) {
            ContingencyStats.grant(request.contingencySnapshot, snp, request.requester);
        }

        // Welch t-testi icin metrik basina 6 sayi cozulebilmeli.
        if (request.metricTo > request.metricFrom) {
            IVeriarfyBiomarkers(biomarkerModule).grantFor(requestId, request.requester);
        }

        emit DisclosureGranted(requestId, request.snapshotCount);
    }

    /**
     * @notice Kabul edilen bir itiraz uzerine acilimi iptal eder.
     *
     * @dev Yalnizca stake sozlesmesi cagirabilir (rapor §2.7.1). Yetki HENUZ
     *      verilmemis olmalidir; verilmis bir izni geri almak teknik olarak
     *      mumkun degildir ve oyle davranmak yaniltici olurdu.
     */
    function revokeDisclosure(uint256 requestId) external nonReentrant {
        if (msg.sender != stakingModule) revert NotStakingModule(msg.sender);

        DisclosureRequest storage request = _requests[requestId];
        if (request.requester == address(0)) revert UnknownRequest(requestId);
        if (request.executed) revert AlreadyFinalized(requestId);
        if (request.revoked) revert DisclosureRevoked(requestId);

        request.revoked = true;
        emit DisclosureRevokedByChallenge(requestId);
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
        // Geriye donuk kisayol: penceredeki ILK SNP. Tek SNP'lik calismalarda
        // eskisiyle ayni davranir.
        return disclosureContingencyAt(requestId, _requests[requestId].snpFrom);
    }

    /// @notice Talep penceresindeki BELIRLI bir SNP'nin sifreli tablosu.
    function disclosureContingencyAt(
        uint256 requestId,
        uint32 snp
    ) public view returns (euint32[3][2] memory) {
        DisclosureRequest storage request = _requests[requestId];
        if (request.requester == address(0)) revert UnknownRequest(requestId);
        if (snp < request.snpFrom || snp >= request.snpTo) {
            revert SnpOutsideWindow(snp, request.snpFrom, request.snpTo);
        }
        return request.contingencySnapshot[snp];
    }

    /// @notice Talebin kapsadigi SNP araligi [from, to).
    function disclosureWindow(
        uint256 requestId
    ) external view returns (uint32 from, uint32 to) {
        DisclosureRequest storage request = _requests[requestId];
        if (request.requester == address(0)) revert UnknownRequest(requestId);
        return (request.snpFrom, request.snpTo);
    }

    /// @notice Talebin kapsadigi metrik araligi [from, to).
    function disclosureMetricWindow(
        uint256 requestId
    ) external view returns (uint32 from, uint32 to) {
        DisclosureRequest storage request = _requests[requestId];
        if (request.requester == address(0)) revert UnknownRequest(requestId);
        return (request.metricFrom, request.metricTo);
    }

    /**
     * @notice Guncel (dondurulmamis) kontenjans tablosunun handle'lari.
     *
     * @dev Panel ve izleme icin. Cozmek yine esikli onaya baglidir.
     */
    function contingencyTable() external view returns (euint32[3][2] memory) {
        // Geriye donuk kisayol: panelin ILK SNP'si. Tek SNP'lik calismalarda
        // eskisiyle ayni davranir.
        return _contingency[0];
    }

    /// @notice Belirli bir SNP'nin guncel kontenjans tablosu.
    function contingencyTableAt(uint32 snp) external view returns (euint32[3][2] memory) {
        if (snp >= snpCount) revert TooManySnps(snp + 1, snpCount);
        return _contingency[snp];
    }

    /// @notice Talebi onaylayan dugumler.
    function disclosureApprovers(uint256 requestId) external view returns (address[] memory) {
        return _requests[requestId].approvers;
    }
}
