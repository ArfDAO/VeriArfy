// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {RarityMath} from "./libraries/RarityMath.sol";

interface IVeriarfyBiomarkerCoverage {
    function metricCoverageWeight(address participant, uint32[] calldata metricIds)
        external
        view
        returns (uint32);

    function metricCoverageTotal(uint32[] calldata metricIds) external view returns (uint256);

    /// @notice Bu metrige gercek veri vermis kisi sayisi — KITLIK fiyatinin girdisi.
    function metricCoverageCount(uint32 metricId) external view returns (uint32);
    /// @notice Istenen metriklerin hangilerinde olcumu oldugu — bit maskesi.
    function metricCoverageMask(address participant, uint32[] calldata metricIds)
        external
        view
        returns (uint256);

    /// @notice Varsayilan acilim penceresinin buyuklugu (metrik sayisi).
    function disclosureWindowSize() external view returns (uint32);
}

interface IVeriarfyProtocol {
    function participantIndex(address account) external view returns (uint32);
    /// @notice Havuzun tamami ve dogrulanmis nadir tasiyici sayisi (rapor §4.3).
    function rarityStats() external view returns (uint32 poolCount, uint32 carriers);
    /// @notice Bu arastirmaciya izin veren nadir tasiyici sayisi.
    function consentRareCount(address researcher) external view returns (uint32);
    /// @notice Bu arastirmaciya izin veren Kurucu Katkici sayisi.
    function consentFoundingCount(address researcher) external view returns (uint32);
    /// @notice Hem nadir hem Kurucu olan izin verenler.
    function consentRareFoundingCount(address researcher) external view returns (uint32);
    /// @notice Ilk 10.000 saglayicidan biri mi?
    function isFoundingContributor(address account) external view returns (bool);
    /// @notice Acilim talebi acar; esik sorgu tipine gore belirlenir (rapor §2.6).
    function requestDisclosure(address researcher, uint8 queryType)
        external
        returns (uint256 requestId);
    /// @notice Talepte secilen SNP'ler.
    function disclosureSnpIds(uint256 requestId) external view returns (uint32[] memory);
    /// @notice Talepte secilen metrikler.
    function disclosureMetricIds(uint256 requestId) external view returns (uint32[] memory);
    /// @notice Katilimcinin ISTENEN SNP'lerden kacinda gercek verisi var?
    function snpCoverageWeight(address participant, uint32[] calldata snpIds)
        external
        view
        returns (uint32);
    /// @notice Istenen SNP'lerin kapsama sayaclari toplami.
    function snpCoverageTotal(uint32[] calldata snpIds) external view returns (uint256);
    /// @notice Bu SNP'ye gercek veri vermis kisi sayisi — KITLIK fiyatinin girdisi.
    function snpCoverageCount(uint32 snpId) external view returns (uint32);
    /// @notice Istenen SNP'lerin hangilerinde verisi oldugu — bit maskesi.
    function snpCoverageMask(address participant, uint32[] calldata snpIds)
        external
        view
        returns (uint256);
    /// @notice Panel buyuklugu ve varsayilan pencere tavani.
    function snpCount() external view returns (uint32);
    function MAX_DISCLOSURE_WINDOW() external view returns (uint32);
    /// @notice Surekli olcum modulu (0 ise calisma yalnizca genomiktir).
    function biomarkerModule() external view returns (address);

    /// @notice Acilim talebini SECILEN alanlar icin acar.
    function requestDisclosureFields(
        address researcher,
        uint8 queryType,
        uint32[] calldata snpIds,
        uint32[] calldata metricIds
    ) external returns (uint256 requestId);
    /// @notice Talebin esigi saglandi mi (BSKK-44 onayi tamam mi)?
    function isDisclosureGranted(uint256 requestId) external view returns (bool);
    /// @notice Havuzdaki toplam katilimci sayisi.
    function participantCount() external view returns (uint32);
    /// @notice Nadir VE kurucu olan katilimci sayisi.
    function rareFoundingCount() external view returns (uint32);
    /// @notice Nadir tasiyici sayisi.
    function rareCarrierCount() external view returns (uint32);
    /// @notice Kurucu katkici siniri.
    function FOUNDING_CONTRIBUTOR_LIMIT() external view returns (uint32);
    /// @notice Katilimci, verilen blokta havuzda MIYDI?
    function wasInPoolAt(address participant, uint256 blockNumber)
        external
        view
        returns (bool);
    /// @notice Nadirligi verilen bloktan ONCE dogrulanmis miydi?
    function rareBefore(address participant, uint256 blockNumber)
        external
        view
        returns (bool);
}

interface IResearcherRegistry {
    function isRegistered(address account) external view returns (bool);
}

/**
 * @title   VeriarfyPayments
 * @notice  Hesaplama basina odeme (Pay-per-Compute) ve gelir paylasimi (RevShare).
 *
 * @dev
 * # Akis
 *
 *   1. Arastirmaci `openQuery()` cagirir ve ucreti stablecoin olarak oder.
 *      Ucret, sorgunun kapsadigi katilimci sayisiyla orantilidir.
 *   2. Ucret ikiye ayrilir: **%80 katilimcilara**, **%20 hazineye**.
 *   3. Sorgu, acildigi andaki katilimci sayisini anlik goruntu olarak saklar.
 *   4. Her katilimci `claim()` ile kendi payini ceker.
 *
 * # Neden utility token yok
 *
 * Rapor §3.5: ilac sirketleri bilancolarinda volatil token tutmayi reddediyor.
 * Bu kontrat herhangi bir ERC-20 ile calisir; uretimde USDC adresi verilir.
 * Kendi tokenimiz YOKTUR ve basilmaz.
 *
 * # Raporun formulunden sapma — bilincli
 *
 * Rapor §4.2 su formulu veriyor:
 *
 *     R_LP = (F_query x 0.80) x (User_Data_Used / Total_Data_Queried)
 *
 * Bu formul `R_LP`'yi kisi basi odul gibi adlandiriyor ama sag taraf TOPLAM
 * havuzu veriyor; kullanicilar arasinda nasil bolunecegi tanimsiz. Ayrica
 * sorgu tum havuzu kapsadiginda oran 1 olur ve formul hicbir bilgi tasimaz.
 *
 * Tutarli olan tek okuma uygulandi:
 *
 *     havuz      = ucret x 0.80
 *     kisi basi  = havuz x (kisinin agirligi / toplam agirlik)
 *
 * # Agirliklar — rapor §4.3
 *
 * Agirlik iki carpandan olusur ve baz puan cinsindendir (10.000 = 1,00x):
 *
 *     Nadirlik Carpani  R = log2(1 + N_havuz / N_tasiyici)   (yalnizca tasiyicilar)
 *     Kurucu Katkici    +%50 kalici                          (ilk 10.000 saglayici)
 *
 * Hicbiri gecerli degilse agirlik 1,00x'tir ve dagitim esit boluse doner —
 * yani nadirlik ozelligi eski davranisin ustune eklenmistir, yerine gecmemistir.
 *
 * # Raporun O(N) sorunu — cozuldu
 *
 * Rapor "her sorgu sonrasi kullanicilarin hak ettigi gelir dahili bakiye
 * olarak kaydedilir" diyor. Bu, sorgu basina N adet depolama yazimi demektir
 * (N = katilimci sayisi) ve 100.000 katilimcida tek bir sorgu blok gaz
 * limitini asar.
 *
 * Burada sorgu O(1) kaydedilir: yalnizca havuz ve anlik katilimci sayisi
 * yazilir. Pay, `claim()` sirasinda hesaplanir. Uygunluk testi de O(1):
 * protokoldeki 1 tabanli `participantIndex` degeri anlik goruntuden kucuk
 * esitse katilimci o sorguya dahildir.
 */
contract VeriarfyPayments is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------------------
    // Hatalar
    // ---------------------------------------------------------------------------------

    error ZeroAddress();
    error NotRegisteredResearcher(address caller);
    error PoolEmpty();
    error UnknownQuery(uint256 queryId);
    error NotAParticipant(address account);
    error NotInThisQuery(address account, uint32 index, uint32 snapshot);
    error AlreadyClaimed(uint256 queryId, address account);
    error NothingToWithdraw();
    error InvalidShare(uint16 share);
    error AlreadySettled(uint256 queryId);
    error AlreadyRefunded(uint256 queryId);
    error NotSettled(uint256 queryId);
    error DisclosureNotGranted(uint256 queryId, uint256 requestId);
    error DisclosureAlreadyGranted(uint256 queryId);
    error NotQueryOwner(uint256 queryId, address caller);
    error RefundTooEarly(uint256 queryId, uint256 availableAtBlock);

    // ---------------------------------------------------------------------------------
    // Olaylar
    // ---------------------------------------------------------------------------------

    event QueryOpened(
        uint256 indexed queryId,
        address indexed researcher,
        uint256 fee,
        uint256 disclosureRequestId,
        uint32 snapshotCount
    );
    event QuerySettled(uint256 indexed queryId, uint256 liquidityPot, uint256 treasuryShare);
    event QueryRefunded(uint256 indexed queryId, address indexed researcher, uint256 amount);
    event RewardClaimed(uint256 indexed queryId, address indexed participant, uint256 amount);
    event TreasuryWithdrawn(address indexed to, uint256 amount);
    event PricingUpdated(uint256 baseFee, uint256 perRecordFee);
    event ScarcityCapUpdated(uint32 maxScarcityBps);

    /// @notice Kitlik tavani 1x'in altina cekilemez (carpan zaten 1'in altina inmiyor).
    error InvalidScarcityCap(uint32 maxScarcityBps);
    event UsageShareUpdated(uint16 usageShareBps);

    // ---------------------------------------------------------------------------------
    // Yapilandirma
    // ---------------------------------------------------------------------------------

    /// @notice Odeme yapilan stablecoin (uretimde USDC).
    IERC20 public immutable token;

    /// @notice Sifreli havuzu tutan protokol — katilimci verisi buradan okunur.
    IVeriarfyProtocol public immutable protocol;

    /// @notice Arastirmaci kimlik kaydi — yalnizca ZK ile dogrulanmislar sorgu acabilir.
    IResearcherRegistry public immutable researchers;

    /**
     * @notice Katilimcilara giden pay (baz puan; 8000 = %80).
     *
     * @dev Rapor §4.2'de sabit %80 olarak veriliyor. Burada sabit degil ama
     *      DEGISTIRILEMEZ: `immutable`. Sebep: dagitim orani, kullanicilarin
     *      veri yuklerken kabul ettigi ekonomik sozlesmenin parcasidir;
     *      sonradan dusurulebilir olsaydi guven varsayimi degisirdi.
     */
    uint16 public immutable liquidityShareBps;

    uint16 public constant BPS_DENOMINATOR = 10_000;

    /**
     * @notice Iade icin beklenmesi gereken blok sayisi (~1 gun).
     *
     * @dev Onay sureci ani degildir; kurumlarin degerlendirme suresi vardir.
     *      Ani iade mumkun olsaydi arastirmaci, onay tam gelmeden parayi geri
     *      cekip sonucu yine de alabilirdi.
     */
    uint256 public constant REFUND_DELAY = 7_200;

    /// @notice Sorgu basina sabit taban ucret (token'in en kucuk biriminde).
    uint256 public baseFee;

    /**
     * @notice Bir KAYIT basina taban ucret. Kayit = (bir kisi x bir alan).
     *
     * @dev  NEDEN KATILIMCI BASINA DEGIL
     *
     *       Onceden fiyat `havuzdaki kisi sayisi` ile carpiliyordu. Iki
     *       yonden de yanlisti:
     *
     *         - Arastirmaci 2 alan istese de 40 alan istese AYNI parayi
     *           oduyordu. Oysa aldigi sey farkli.
     *         - Istedigi alanda verisi OLMAYAN kisiler icin de oduyordu.
     *           Havuzda 1000 kisi olup istenen alanda 12'sinde veri varsa,
     *           satin alinan sey 12 kayittir; 1000 degil.
     *
     *       Artik carpan, istenen alanlarin KAPSAMA TOPLAMIDIR: her alan
     *       icin o alana gercekten veri vermis kisi sayisi. Bu, odemenin
     *       dagitildigi paydayla (`coverageTotal`) BIREBIR ayni sayidir —
     *       yani arastirmacinin odedigi ile katilimcinin hak ettigi ayni
     *       olcuye dayanir.
     */
    uint256 public perRecordFee;

    /**
     * @notice Kitlik carpaninin TAVANI (baz puan). Varsayilan 100.000 = 10x.
     *
     * @dev  TAVAN, TOPLAM FIYATI SINIRLAMAZ — bunu belirtmek onemli
     *
     *       Ilk bakista tavan bir "guvenlik sinir" gibi gorunur. Degildir:
     *       alan ucreti zaten kendiliginden sinirlidir.
     *
     *           ucret(alan) = kayit x perRecordFee x (havuz / kayit)
     *                       = perRecordFee x havuz
     *
     *       Yani carpan tavansiz olsa bile bir alanin ucreti asla
     *       `perRecordFee x havuz` degerini asamaz. Tavani yukseltmek
     *       kimseyi iflas ettirmez.
     *
     *       TAVANIN GERCEK ISLEVI: kitlik ayrimin NEREDE DURACAGI
     *
     *       Tavan `C` iken, kapsamasi `havuz/C` degerinin ALTINDA olan tum
     *       alanlar AYNI kisi basi fiyati alir — ayrim orada durur.
     *
     *         C = 4x  -> %25'in altindaki her alan ayni fiyatta (kaba ayrim)
     *         C = 10x -> %10'a kadar ayrim surer   (varsayilan)
     *         C = 1x  -> kitlik tamamen kapali
     *
     *       10x secildi cunku gercekci nadir kohortlar (nadir hastalik,
     *       spesifik klinik grup) tipik olarak havuzun %1-%10'udur; ayrimin
     *       tam orada kesilmesi mekanizmayi islevsiz birakirdi.
     *
     *       Diger yonu: tavan DUSTUKCE seyrek alanin TOPLAM ucreti duser
     *       (daha az veri satin aliniyor), kisi basi ucreti ise tavanda
     *       sabitlenir. Yukseldikce seyrek alan toplamda da yaygin alana
     *       yaklasir. Ikisi arasindaki denge urun karari; `setScarcityCap`
     *       ile calisma aninda degistirilebilir.
     */
    /// @dev uint32: tavan 65.535 baz puani (6,5x) asabilmeli, uint16 yetmez.
    uint32 public maxScarcityBps;

    // ---------------------------------------------------------------------------------
    // Sorgu kayitlari
    // ---------------------------------------------------------------------------------

    /**
     * @notice Katilimci havuzunun KULLANIM payina giden orani (baz puan).
     *
     * @dev  NEDEN IKI HAVUZ
     *
     *       Istenen davranis "verisi kullanildigi kadar kazansin". Bonuslari
     *       (nadirlik, kurucu katkici) kullanim sayisiyla CARPMAK matematiksel
     *       olarak mumkun ama paydasi O(1) hesaplanamaz:
     *
     *           Σ_kisi [ eslesme(kisi) x bonus(kisi) ]
     *
     *       ayrisamaz. Tum katilimcilari dolasmak ise binlerce kiside
     *       imkansizdir.
     *
     *       Iki AYRI havuz her ikisini de TAM olarak hesaplanabilir kilar:
     *
     *         kullanim havuzu : eslesme(kisi) / kapsamaToplami   -> O(alan)
     *         bonus havuzu    : agirlik(kisi) / toplamAgirlik    -> O(1)
     *
     *       Yaklasiklik yok, dolasma yok. Bonusun anlami da korunur: nadirlik
     *       carpani "hangi alani verdin"den bagimsiz bir odul olarak durur.
     */
    uint16 public usageShareBps;

    /**
     * @notice Sorgu -> ISTENEN ALANLARIN dondurulmus kitlik agirliklari (baz puan).
     *
     * @dev  NEDEN DONDURULUYOR
     *
     *       Kitlik `havuz / o alani verenler` demektir ve ikisi de sorgudan
     *       SONRA degismeye devam eder. Pay hesabinda guncel deger
     *       kullanilsaydi, erken cekenle gec ceken farkli agirlik gorurdu ve
     *       paylarin toplami dondurulmus havuzu asabilirdi.
     *
     *       Sira, `disclosureSnpIds` + `disclosureMetricIds` birlesimidir;
     *       `weightedCoverage` ayni sirayi okur.
     *
     *       Maliyet: `uint32[]` Solidity tarafindan yuvaya 8'erli paketlenir,
     *       yani talep tavaninda (32 + 16) yalnizca 6 yuva.
     */
    mapping(uint256 => uint32[]) private _fieldScarcity;

    struct Query {
        address researcher;
        uint256 fee;
        /// @dev Katilimcilara ayrilan toplam (ucretin %80'i).
        uint256 liquidityPot;
        /// @dev Sorgu acildigi anda bu arastirmaciya izin veren kisi sayisi.
        uint32 snapshotCount;
        /**
         * @dev Sorgunun acildigi blok.
         *
         * Hakedis bu bloga gore belirlenir: "izin SU AN gecerli mi" sorusu
         * yanlis olurdu — sorgudan sonra izni iptal eden katilimci hak ettigi
         * payi kaybederdi.
         */
        uint256 openedAtBlock;
        /// @dev Bu sorgudan simdiye kadar cekilen toplam.
        uint256 claimedTotal;
        /// @dev Protokoldeki BSKK-44 acilim talebinin kimligi.
        uint256 disclosureRequestId;
        /**
         * @dev Talep anindaki KAPSAMA TOPLAMI — kullanim havuzunun paydasi.
         *
         * Istenen alanlarin her birine gercek veri vermis kisi sayilarinin
         * toplami. Katilimci sayisi gibi DONDURULUR: sorgu acildiktan sonra
         * yeni katilimcilar gelmeye devam eder, ama bu sorgunun paydasi
         * degismemelidir — aksi halde daha once hesaplanan paylar toplami
         * havuzu asabilirdi.
         */
        uint256 coverageTotal;
        /**
         * @dev KITLIKLA AGIRLIKLANDIRILMIS kapsama toplami — kullanim payinin PAYDASI.
         *
         * `Σ (o alani verenler x kitlik(alan))`. Ucretin alan bileseniyle
         * ayni formul; boylece arastirmacinin odedigi ile katilimcilarin
         * toplam hakedisi ayni olcuye dayanir.
         *
         * `coverageTotal` (ham kayit sayisi) gosterim ve "dagitilacak bir sey
         * var mi" kontrolu icin AYRICA durur.
         */
        uint256 weightedTotal;
        /**
         * @dev Ucret HENUZ dagitilmadi mi?
         *
         * Rapor §2.6: sorgu, yetkili kurumlarin coklu imza onayi olmadan
         * "yurutulemez". Ucret bu yuzden emanette (escrow) tutulur; onay
         * gelmeden ne katilimcilara ne hazineye gecer.
         */
        bool settled;
        bool refunded;
        /**
         * @dev Nadirlik Carpani, sorgu acildigi anda SABITLENIR.
         *
         * `R = log2(1 + N/C)` havuz buyudukce degisir. Sabitlenmeseydi, bir
         * sorgudan alinacak pay sorgudan SONRA havuza katilan kisilere gore
         * degisirdi ve paylarin toplami havuzu asabilirdi.
         *
         * Yalnizca iki sayi saklanir; carpan bunlardan yeniden hesaplanir
         * (`RarityMath` saf fonksiyondur). Boylece kayit O(1) kalir.
         */
        uint32 snapshotPoolCount;
        uint32 snapshotCarriers;
        /**
         * @dev Anlik goruntudeki TOPLAM agirlik (baz puan).
         *
         * Bireysel paylarin paydasi. Sorgu aninda dort sayacdan O(1) hesaplanir;
         * izin verenler listesi hicbir zaman dolasilmaz.
         */
        uint256 totalWeightBps;
    }

    mapping(uint256 queryId => Query) private _queries;
    mapping(uint256 queryId => mapping(address => bool)) public hasClaimed;

    /// @notice Bir sonraki sorgunun kimligi.
    uint256 public nextQueryId;

    /// @notice Hazinede biriken tutar (%20 + bolme artiklari).
    uint256 public treasuryBalance;

    /**
     * @notice Sistemden bugune kadar GECEN toplam ucret — rapor §2.7.1
     *         formulundeki `TotalDataValue`.
     *
     * @dev Hazine bakiyesinden farklidir: hazine cekildikce azalir, bu sayac
     *      azalmaz. Progresif teminat "ag ne kadar deger tasidi" sorusuna
     *      bakar; "kasada su an ne var" sorusuna degil.
     */
    uint256 public cumulativeFees;

    // ---------------------------------------------------------------------------------

    constructor(
        address initialOwner,
        address token_,
        address protocol_,
        address researchers_,
        uint16 liquidityShareBps_,
        uint256 baseFee_,
        uint256 perRecordFee_
    ) Ownable(initialOwner) {
        if (token_ == address(0) || protocol_ == address(0) || researchers_ == address(0)) {
            revert ZeroAddress();
        }
        // Katilimci payi hazineden buyuk olmali; aksi bir yapilandirma raporun
        // ekonomik modeliyle celisir.
        if (liquidityShareBps_ < 5_000 || liquidityShareBps_ > BPS_DENOMINATOR) {
            revert InvalidShare(liquidityShareBps_);
        }

        token = IERC20(token_);
        protocol = IVeriarfyProtocol(protocol_);
        researchers = IResearcherRegistry(researchers_);
        liquidityShareBps = liquidityShareBps_;

        // Varsayilan: katilimci havuzunun %70'i KULLANIMA, %30'u bonuslara.
        // Sahip tarafindan degistirilebilir; ikisi de tam hesaplanabilir.
        usageShareBps = 7_000;

        // Varsayilan kitlik tavani 10x — ayrim havuzun %10'una kadar surer.
        // Kitligi tamamen kapatmak icin BPS_DENOMINATOR (1x) verilebilir.
        maxScarcityBps = 100_000;

        baseFee = baseFee_;
        perRecordFee = perRecordFee_;
        emit PricingUpdated(baseFee_, perRecordFee_);
    }

    /**
     * @notice Kullanim/bonus dagilimini ayarlar.
     *
     * @dev ACIK UCLARA IZIN VERILIR: 0 = tamamen bonus (eski davranis),
     *      10.000 = tamamen kullanim. Ikisi de tutarli birer politikadir.
     */
    function setUsageShare(uint16 usageShareBps_) external onlyOwner {
        if (usageShareBps_ > BPS_DENOMINATOR) revert InvalidShare(usageShareBps_);
        usageShareBps = usageShareBps_;
        emit UsageShareUpdated(usageShareBps_);
    }

    // ---------------------------------------------------------------------------------
    // Fiyatlandirma
    // ---------------------------------------------------------------------------------

    /**
     * @notice Su an VARSAYILAN pencereyle bir sorgu acmanin maliyeti.
     *
     * @dev Alan secen arastirmaci `quoteForFields` kullanmalidir; buradaki
     *      rakam yalnizca "hicbir sey secmezsem ne oder" sorusunun yanitidir.
     */
    function quote() public view returns (uint256 fee, uint256 records) {
        return quoteForFields(_defaultIds(_defaultSnpWindow()), _defaultIds(_defaultMetricWindow()));
    }

    /**
     * @notice ISTENEN ALANLARIN ucreti.
     *
     * @dev  FIYAT NEYE GORE — uc bilesen
     *
     *       1. TABAN. Sorgu basina sabit; zincir uzerindeki dogrulama ve
     *          esikli onay maliyetini karsilar. Alan sayisindan bagimsizdir.
     *
     *       2. KAYIT SAYISI. Kayit = (bir kisi x bir alan). Arastirmaci
     *          {rs4977574, VO2MAX} isterse ve bunlara sirasiyla 12 ve 30
     *          kisi veri vermisse, satin alinan sey 42 kayittir.
     *
     *          Havuzda kac kisi oldugu ONEMSIZDIR. Istenen alanda verisi
     *          olmayan kisi icin odeme yapilmaz — cunku o kisiden bir sey
     *          alinmiyor. Bu sayi, odemenin dagitildigi paydayla
     *          (`coverageTotal`) BIREBIR ayni: arastirmacinin odedigi ile
     *          katilimcinin hak ettigi ayni olcuye dayanir.
     *
     *       3. KITLIK. Az bulunan veri kisi basina DAHA PAHALIDIR.
     *
     *              carpan(alan) = havuz / o alani verenler     (tavanli)
     *
     *          Nadir bir hastalik kohortunun verisi havuzun %5'indeyse,
     *          o alanin kayit fiyati tavana kadar yukselir. Yaygin bir
     *          varyant (herkeste var) 1x kalir.
     *
     *          Kitlik zincirden TURETILIR, sahip tarafindan atanmaz. Bu
     *          bilincli: "hangi veri degerli" karari birinin insafina
     *          birakilsaydi, fiyat piyasanin degil sahibin karari olurdu.
     *
     *       SINIR — durustce: kitlik, degerin MUKEMMEL bir vekili degildir.
     *       Az doldurulmus onemsiz bir alan da pahali gorunur. Gercek klinik
     *       deger (kanser kohortu vb.) ancak calisma panelinin nasil
     *       tanimlandigiyla gelir; fiyat oradan devralir.
     *
     * @return fee     Toplam ucret.
     * @return records Satin alinan kayit sayisi (kisi x alan) — kitliktan ONCE.
     */
    function quoteForFields(
        uint32[] memory snpIds,
        uint32[] memory metricIds
    ) public view returns (uint256 fee, uint256 records) {
        uint32 pool = protocol.participantCount();

        fee = baseFee;

        for (uint256 i = 0; i < snpIds.length; ++i) {
            uint32 count = protocol.snpCoverageCount(snpIds[i]);
            records += count;
            fee += _fieldPrice(count, pool);
        }

        address module = protocol.biomarkerModule();
        if (module != address(0)) {
            for (uint256 i = 0; i < metricIds.length; ++i) {
                uint32 count = IVeriarfyBiomarkerCoverage(module).metricCoverageCount(metricIds[i]);
                records += count;
                fee += _fieldPrice(count, pool);
            }
        }
    }

    /**
     * @notice Tek bir alanin ucreti: `kayit sayisi x taban x kitlik`.
     *
     * @dev Kimsede yoksa BEDAVADIR. Satilacak veri olmadan ucret almak,
     *      ucretin tamaminin hazineye gitmesi demek olurdu.
     */
    function _fieldPrice(uint32 count, uint32 pool) private view returns (uint256) {
        return (perRecordFee * count * _scarcityBps(count, pool)) / BPS_DENOMINATOR;
    }

    /**
     * @notice Bir alanin kitlik carpani (baz puan). Kimsede yoksa SIFIR.
     *
     * @dev  ODEMENIN DE AGIRLIGI — fiyatla AYNI sayi
     *
     *       Bu carpan yalnizca fiyatta kullanilsaydi mimari kendi icinde
     *       celisirdi: arastirmaci nadir alan icin 10 kat oderdi ama o alanin
     *       sahibi, yaygin bir alanin sahibiyle AYNI payi alirdi. Fazla para
     *       herkese esit dagilir, yani nadir veri sahibinin hakki kalabaligin
     *       icinde erirdi.
     *
     *       Bu yuzden ayni carpan, sorgu acilirken DONDURULUR ve pay
     *       hesabinda da kullanilir (`weightedCoverage`). Odenen ile hak
     *       edilen tek bir formulden gelir.
     */
    function _scarcityBps(uint32 count, uint32 pool) private view returns (uint32) {
        // Kimsede yoksa alan bedavadir ve agirligi da yoktur.
        if (count == 0) return 0;

        // Kitlik = havuzun kac katinda bu alan YOK. Tabani 1x'tir: bir alan
        // herkeste varsa indirim UYGULANMAZ, yalnizca zam uygulanmaz.
        uint256 scarcity = (uint256(pool) * BPS_DENOMINATOR) / count;
        if (scarcity < BPS_DENOMINATOR) scarcity = BPS_DENOMINATOR;
        if (scarcity > maxScarcityBps) scarcity = maxScarcityBps;

        return uint32(scarcity);
    }

    /**
     * @notice Sorgu acilirken fiyati hesaplar ve kitlik agirliklarini DONDURUR.
     *
     * @dev `quoteForFields` ile ayni formuldur ama ek olarak agirliklari
     *      saklar. Iki ayri gecis yazilsaydi biri degisip digeri unutulabilir,
     *      ve fiyat ile pay sessizce ayrisabilirdi — sessiz ayrisma, paranin
     *      yanlis yere gitmesi demektir.
     */
    function _snapshotPricing(
        uint256 queryId,
        uint256 requestId,
        uint32 pool
    ) private returns (uint256 fee, uint256 weightedTotal) {
        uint32[] memory snpIds = protocol.disclosureSnpIds(requestId);
        uint32[] storage scarcity = _fieldScarcity[queryId];

        fee = baseFee;

        for (uint256 i = 0; i < snpIds.length; ++i) {
            uint32 count = protocol.snpCoverageCount(snpIds[i]);
            uint32 bps = _scarcityBps(count, pool);

            scarcity.push(bps);
            fee += (perRecordFee * count * bps) / BPS_DENOMINATOR;
            weightedTotal += uint256(count) * bps;
        }

        address module = protocol.biomarkerModule();
        if (module == address(0)) return (fee, weightedTotal);

        uint32[] memory metricIds = protocol.disclosureMetricIds(requestId);
        for (uint256 i = 0; i < metricIds.length; ++i) {
            uint32 count = IVeriarfyBiomarkerCoverage(module).metricCoverageCount(metricIds[i]);
            uint32 bps = _scarcityBps(count, pool);

            scarcity.push(bps);
            fee += (perRecordFee * count * bps) / BPS_DENOMINATOR;
            weightedTotal += uint256(count) * bps;
        }
    }

    /// @dev `[0, 1, ... n-1]` — varsayilan alan listesi.
    function _defaultIds(uint32 n) private pure returns (uint32[] memory ids) {
        ids = new uint32[](n);
        for (uint32 i = 0; i < n; ++i) ids[i] = i;
    }

    /// @dev Protokolun varsayilan SNP penceresi — `requestDisclosure` ile AYNI.
    function _defaultSnpWindow() private view returns (uint32) {
        uint32 total = protocol.snpCount();
        uint32 cap = protocol.MAX_DISCLOSURE_WINDOW();
        return total > cap ? cap : total;
    }

    /// @dev Modul yoksa metrik penceresi sifirdir.
    function _defaultMetricWindow() private view returns (uint32) {
        address module = protocol.biomarkerModule();
        if (module == address(0)) return 0;
        return IVeriarfyBiomarkerCoverage(module).disclosureWindowSize();
    }

    function setPricing(uint256 baseFee_, uint256 perRecordFee_) external onlyOwner {
        baseFee = baseFee_;
        perRecordFee = perRecordFee_;
        emit PricingUpdated(baseFee_, perRecordFee_);
    }

    /**
     * @notice Kitlik tavanini gunceller.
     *
     * @dev Taban BPS_DENOMINATOR'dur (1x): kitligin fiyati DUSURMESI
     *      anlamsiz olurdu, cunku carpan zaten 1'in altina inmiyor.
     */
    function setScarcityCap(uint32 maxScarcityBps_) external onlyOwner {
        if (maxScarcityBps_ < BPS_DENOMINATOR) revert InvalidScarcityCap(maxScarcityBps_);
        maxScarcityBps = maxScarcityBps_;
        emit ScarcityCapUpdated(maxScarcityBps_);
    }

    // ---------------------------------------------------------------------------------
    // Sorgu acma
    // ---------------------------------------------------------------------------------

    /**
     * @notice Ucreti oder ve sorguyu acar. Cagiran once `approve` etmelidir.
     *
     * @dev Havuz bos ise sorgu acilamaz: dagitilacak kimse olmadan ucret
     *      tahsil etmek, ucretin tamaminin hazineye gitmesi demek olurdu.
     *
     * @return queryId Acilan sorgunun kimligi.
     */
    /**
     * @notice Ucreti EMANETE alir ve BSKK-44 acilim talebini acar.
     *
     * @dev  Rapor §2.6: sorgu, yetkili kurum dugumlerinin coklu imza onayi
     *       olmadan "yurutulemez". Bu yuzden ucret burada dagitilMAZ; onay
     *       gelene kadar kontratta emanette bekler.
     *
     *         onay gelirse  -> `settleQuery` ile %80/%20 bolusur,
     *         gelmezse      -> `refundQuery` ile arastirmaciya iade edilir.
     *
     *       Bu bag olmadan arastirmaci odeme yapip onay almadan da veri
     *       almis gibi gorunurdu; ya da tersi, onay alinmadan katilimcilar
     *       hak etmedikleri odemeyi cekebilirdi.
     *
     * @param queryType Sorgu hassasiyeti (GWAS | ML | STATISTICS). Gereken
     *        onay orani buna gore belirlenir — rapor §2.6.
     */
    /**
     * @notice Sorguyu SECILEN ALANLAR icin acar.
     *
     * @dev  NEDEN KAPIDAN GECIYOR
     *
     *       Her arastirmaci ayni veriyle calismaz: birine `rs4977574` ve
     *       VO2 max lazimdir, digerine bambaska bir kume. Secim protokole
     *       kapi uzerinden iletilir cunku ucret emaneti ve arastirmaci kaydi
     *       kontrolu burada yapilir.
     *
     * @param snpIds    Istenen SNP indeksleri.
     * @param metricIds Istenen metrik indeksleri; bos birakilabilir.
     */
    function openQueryFields(
        uint8 queryType,
        uint32[] calldata snpIds,
        uint32[] calldata metricIds
    ) external nonReentrant returns (uint256 queryId) {
        return _openQuery(queryType, snpIds, metricIds, true);
    }

    function openQuery(uint8 queryType) external nonReentrant returns (uint256 queryId) {
        uint32[] calldata empty;
        assembly {
            empty.offset := 0
            empty.length := 0
        }
        return _openQuery(queryType, empty, empty, false);
    }

    function _openQuery(
        uint8 queryType,
        uint32[] calldata snpIds,
        uint32[] calldata metricIds,
        bool explicitFields
    ) private returns (uint256 queryId) {
        if (!researchers.isRegistered(msg.sender)) {
            revert NotRegisteredResearcher(msg.sender);
        }

        uint32 participants = protocol.participantCount();
        // Havuz bossa sorgu acilamaz: dagitilacak kimse yokken ucret tahsil
        // etmek, ucretin tamaminin hazineye gitmesi demek olurdu.
        if (participants == 0) revert PoolEmpty();

        // SIRA DEGISTI — once talep, sonra tahsilat.
        //
        // Ucret artik ISTENEN ALANLARIN kapsamasindan hesaplaniyor. Alan
        // secilmeyen yolda alanlari protokol belirler, yani liste ancak
        // talep acildiktan sonra kesinlesir. Ayni islem icinde oldugumuz
        // icin bu guvenli: transfer duserse talep de geri alinir.
        uint256 requestId = explicitFields
            ? protocol.requestDisclosureFields(msg.sender, queryType, snpIds, metricIds)
            : protocol.requestDisclosure(msg.sender, queryType);

        queryId = nextQueryId;

        // Fiyat ve pay agirliklari AYNI gecisten cikar; ayri hesaplansalardi
        // sessizce ayrisabilirlerdi.
        (uint256 fee, uint256 weightedTotal) = _snapshotPricing(queryId, requestId, participants);

        // `SafeERC20` donus degeri olmayan token'lari da dogru isler (USDT
        // gibi standarda tam uymayan uygulamalar mevcut).
        token.safeTransferFrom(msg.sender, address(this), fee);

        // Nadirlik anlik goruntusu (rapor §4.3). Carpanin girdisi HAVUZUN
        // TAMAMIDIR; izin verenlerin sayisi degil — nadirlik, varyantin
        // populasyondaki gercek seyrekligidir.
        (uint32 poolCount, uint32 carriers) = protocol.rarityStats();

        nextQueryId++;
        _queries[queryId] = Query({
            researcher: msg.sender,
            fee: fee,
            // Havuz `settleQuery` aninda hesaplanir; onay gelmezse ucretin
            // tamami iade edilecegi icin simdiden bolmek yanlis olurdu.
            liquidityPot: 0,
            snapshotCount: participants,
            openedAtBlock: block.number,
            claimedTotal: 0,
            disclosureRequestId: requestId,
            settled: false,
            refunded: false,
            coverageTotal: _coverageTotal(requestId),
            weightedTotal: weightedTotal,
            snapshotPoolCount: poolCount,
            snapshotCarriers: carriers,
            totalWeightBps: _totalWeightBps(msg.sender, participants, poolCount, carriers)
        });

        emit QueryOpened(queryId, msg.sender, fee, requestId, participants);
    }

    /**
     * @notice BSKK-44 onayi geldikten sonra ucreti dagitima acar.
     *
     * @dev Herkes cagirabilir: onay zaten zincirde gorunur bir olgudur ve
     *      dagitimin baslamasi kimsenin insafina birakilmamalidir.
     */
    function settleQuery(uint256 queryId) external nonReentrant {
        Query storage q = _queries[queryId];
        if (q.snapshotCount == 0) revert UnknownQuery(queryId);
        if (q.settled) revert AlreadySettled(queryId);
        if (q.refunded) revert AlreadyRefunded(queryId);

        if (!protocol.isDisclosureGranted(q.disclosureRequestId)) {
            revert DisclosureNotGranted(queryId, q.disclosureRequestId);
        }

        uint256 liquidityPot = (q.fee * liquidityShareBps) / BPS_DENOMINATOR;
        q.liquidityPot = liquidityPot;
        q.settled = true;

        treasuryBalance += q.fee - liquidityPot;

        // Rapor §2.7.1'deki "TotalDataValue" — progresif teminatin girdisi.
        // Iade edilen sorgular sayilmaz: iade, sistemden deger gecmedigi
        // anlamina gelir. Bu yuzden sayac `openQuery`'de degil BURADA artar.
        cumulativeFees += q.fee;

        emit QuerySettled(queryId, liquidityPot, q.fee - liquidityPot);
    }

    /**
     * @notice Onay gelmediyse ucreti arastirmaciya iade eder.
     *
     * @dev  `REFUND_DELAY` neden var: onay sureci ani degildir, kurumlarin
     *       degerlendirmesi gerekir. Ani iade mumkun olsaydi arastirmaci
     *       onay tam gelmeden parayi geri cekip sonucu yine de alabilirdi.
     *
     *       Onay geldikten sonra iade EDILEMEZ: `isDisclosureGranted` kontrolu
     *       bunu engeller. Aksi halde arastirmaci sonucu alip parasini geri
     *       isteyebilirdi.
     */
    function refundQuery(uint256 queryId) external nonReentrant {
        Query storage q = _queries[queryId];
        if (q.snapshotCount == 0) revert UnknownQuery(queryId);
        if (q.settled) revert AlreadySettled(queryId);
        if (q.refunded) revert AlreadyRefunded(queryId);
        if (msg.sender != q.researcher) revert NotQueryOwner(queryId, msg.sender);

        if (protocol.isDisclosureGranted(q.disclosureRequestId)) {
            revert DisclosureAlreadyGranted(queryId);
        }
        if (block.number < q.openedAtBlock + REFUND_DELAY) {
            revert RefundTooEarly(queryId, q.openedAtBlock + REFUND_DELAY);
        }

        q.refunded = true;
        token.safeTransfer(q.researcher, q.fee);

        emit QueryRefunded(queryId, q.researcher, q.fee);
    }

    // ---------------------------------------------------------------------------------
    // Pay cekme
    // ---------------------------------------------------------------------------------

    /**
     * @notice Bir sorgudan hak edilen payi ceker.
     *
     * @dev Uygunluk iki kosula baglidir ve ikisi de O(1):
     *
     *      1. Adres havuza veri koymus olmali (`participantIndex != 0`),
     *      2. Sorgunun ACILDIGI BLOKTA bu arastirmaciya izni yururlukte olmali.
     *
     *      Ikinci kosul neden blok bazli: "izin su an gecerli mi" denseydi,
     *      sorgudan sonra iznini iptal eden katilimci hak ettigi payi
     *      kaybederdi. Tersi de gecerli: sorgudan sonra izin veren biri, o
     *      sorgudan pay alamaz — verisi hesaplamaya girmemistir.
     */
    function claim(uint256 queryId) external nonReentrant returns (uint256 amount) {
        Query storage q = _queries[queryId];
        if (q.snapshotCount == 0) revert UnknownQuery(queryId);
        if (hasClaimed[queryId][msg.sender]) revert AlreadyClaimed(queryId, msg.sender);

        if (!q.settled) revert NotSettled(queryId);
        uint256 index = protocol.participantIndex(msg.sender);
        if (index == 0) revert NotAParticipant(msg.sender);

        // IZIN KAPISI YOK. Sorulan iki sey var: sorgudan ONCE mi katildin, ve
        // sorgu acildiginda hala havuzda miydin? Ayrinti `claimable` icinde.
        if (index > q.snapshotCount || !protocol.wasInPoolAt(msg.sender, q.openedAtBlock)) {
            revert NotInThisQuery(msg.sender, uint32(index), q.snapshotCount);
        }

        // Tutar `claimable` ile AYNI ifadeden gelmelidir. Iki yerde ayri ayri
        // yazilsaydi (bir kere burada, bir kere gorunumde) panelde gosterilen
        // ile odenen sessizce ayrisirdi — nitekim nadirlik agirliklari
        // eklenirken tam bu oldu ve test yakaladi.
        amount = claimable(queryId, msg.sender);

        hasClaimed[queryId][msg.sender] = true;
        q.claimedTotal += amount;

        token.safeTransfer(msg.sender, amount);
        emit RewardClaimed(queryId, msg.sender, amount);
    }

    /** @notice Bir adresin belirli bir sorgudan cekebilecegi tutar (0 = uygun degil). */
    /**
     * @dev Talepte istenen alanlarin KAPSAMA TOPLAMI — kullanim havuzunun
     *      paydasi.
     *
     *      Genomik ve surekli olcum kanallari AYRI kontratlarda; toplam
     *      ikisinden derlenir. Maliyet O(istenen alan sayisi) — katilimci
     *      sayisindan bagimsiz.
     */
    function _coverageTotal(uint256 requestId) private view returns (uint256 total) {
        total = protocol.snpCoverageTotal(protocol.disclosureSnpIds(requestId));

        address module = protocol.biomarkerModule();
        if (module != address(0)) {
            uint32[] memory metricIds = protocol.disclosureMetricIds(requestId);
            if (metricIds.length > 0) {
                total += IVeriarfyBiomarkerCoverage(module).metricCoverageTotal(metricIds);
            }
        }
    }

    /**
     * @notice Katilimcinin bu sorguda KAC ALANA veri verdigi.
     *
     * @dev Kullanim payinin PAYI. "Ne kadar veriniz kullanildiysa o kadar
     *      kazanirsiniz" ifadesinin sayisal karsiligi budur.
     */
    function coverageWeight(uint256 queryId, address account) public view returns (uint256 matched) {
        uint256 requestId = _queries[queryId].disclosureRequestId;

        matched = protocol.snpCoverageWeight(account, protocol.disclosureSnpIds(requestId));

        address module = protocol.biomarkerModule();
        if (module != address(0)) {
            uint32[] memory metricIds = protocol.disclosureMetricIds(requestId);
            if (metricIds.length > 0) {
                matched += IVeriarfyBiomarkerCoverage(module).metricCoverageWeight(
                    account,
                    metricIds
                );
            }
        }
    }

    /**
     * @notice Katilimcinin bu sorgudaki KITLIKLA AGIRLIKLANDIRILMIS kapsamasi.
     *
     * @dev  Kullanim payinin PAYIDIR. `coverageWeight` "kac alan" der; bu
     *       "hangi alanlar, ne kadar degerli" der.
     *
     *       Agirliklar sorgu acilirken donduruldu (`_fieldScarcity`), yani
     *       erken ceken ile gec ceken AYNI sayiyi gorur. Guncel kitlik
     *       kullanilsaydi paylarin toplami havuzu asabilirdi.
     *
     *       Kapsama, alan basina ayri cagri yerine TEK bir bit maskesiyle
     *       okunur; talep tavani (32 SNP + 16 metrik) maskeye sigar.
     */
    function weightedCoverage(uint256 queryId, address account)
        public
        view
        returns (uint256 weight)
    {
        uint256 requestId = _queries[queryId].disclosureRequestId;
        uint32[] storage scarcity = _fieldScarcity[queryId];

        uint32[] memory snpIds = protocol.disclosureSnpIds(requestId);
        uint256 mask = protocol.snpCoverageMask(account, snpIds);

        for (uint256 i = 0; i < snpIds.length; ++i) {
            if (mask & (uint256(1) << i) != 0) weight += scarcity[i];
        }

        address module = protocol.biomarkerModule();
        if (module == address(0)) return weight;

        uint32[] memory metricIds = protocol.disclosureMetricIds(requestId);
        if (metricIds.length == 0) return weight;

        uint256 metricMask = IVeriarfyBiomarkerCoverage(module).metricCoverageMask(
            account,
            metricIds
        );

        // Metrik agirliklari, SNP'lerden SONRA gelir — `_snapshotPricing`
        // ile ayni sira.
        uint256 offset = snpIds.length;
        for (uint256 i = 0; i < metricIds.length; ++i) {
            if (metricMask & (uint256(1) << i) != 0) weight += scarcity[offset + i];
        }
    }

    /**
     * @notice Havuzun kullanim ve bonus bilesenleri.
     *
     * @dev KAPSAMA TOPLAMI SIFIRSA kullanim havuzu dagitilamaz — istenen
     *      alanlarin hicbirine kimse veri vermemis demektir. O tutar
     *      kilitlenmez, BONUS havuzuna eklenir; aksi halde para sozlesmede
     *      olu kalirdi.
     */
    function potSplit(uint256 queryId) public view returns (uint256 usagePot, uint256 bonusPot) {
        Query storage q = _queries[queryId];
        if (q.weightedTotal == 0) return (0, q.liquidityPot);

        usagePot = (q.liquidityPot * usageShareBps) / BPS_DENOMINATOR;
        bonusPot = q.liquidityPot - usagePot;
    }

    function claimable(uint256 queryId, address account) public view returns (uint256) {
        Query storage q = _queries[queryId];
        if (q.snapshotCount == 0 || hasClaimed[queryId][account]) return 0;
        // Onay gelmeden pay hesaplanmaz: ucret henuz emanettedir.
        if (!q.settled) return 0;
        // SORGUDAN SONRA KATILAN O SORGUYA DAHIL DEGILDIR.
        //
        // Onceden bu siniri izin kapisi ORTUK olarak sagliyordu: izin ancak
        // havuza girdikten sonra verilebiliyordu, dolayisiyla `grantedAtBlock
        // <= openedAtBlock` kontrolu ayni ise yariyordu. Izin kalkinca sinir
        // aciga cikti ve ACIKCA yazilmasi gerekti — yoksa sonradan katilan da
        // pay alir, paylarin toplami dondurulmus paydayi asardi.
        //
        // Katilimci indeksi 1 TABANLIDIR ve tam bunun icin oyle tasarlandi:
        // indeksi anlik goruntudeki sayidan kucuk esit olan herkes dahildir.
        uint256 index = protocol.participantIndex(account);
        if (index == 0 || index > q.snapshotCount) return 0;

        // Havuzdan cikan, cikistan SONRAKI sorgulardan pay almaz.
        if (!protocol.wasInPoolAt(account, q.openedAtBlock)) return 0;

        (uint256 usagePot, uint256 bonusPot) = potSplit(queryId);

        // KULLANIM: hangi alanlara veri verdiysen ve o alanlar NE KADAR
        // NADIRSE o kadar. Payda ile pay ayni agirlik sistemini kullanir,
        // ve o sistem ucreti belirleyenle AYNIDIR.
        uint256 usage = q.weightedTotal == 0
            ? 0
            : (usagePot * weightedCoverage(queryId, account)) / q.weightedTotal;

        // BONUS: nadirlik ve kurucu katkici carpani — hangi alani verdiginden
        // bagimsiz. Payda sifir olamaz: `snapshotCount > 0` ise en az bir izin
        // veren vardir ve her agirlik en az `ONE_BPS`'tir.
        uint256 bonus = (bonusPot * weightOf(queryId, account)) / q.totalWeightBps;

        return usage + bonus;
    }

    /**
     * @notice Bir katilimcinin BELIRLI BIR SORGUDAKI agirligi (baz puan).
     *
     * @dev  Nadirlik SORGU ANINA gore okunur, guncel duruma gore DEGIL.
     *
     *       Sebep: paydayi olusturan sayaclar sorgu acilirken dondurulur.
     *       Biri sorgu acildiktan SONRA nadirligini dogrularsa, bireysel
     *       agirligi buyur ama payda ayni kalir — paylarin toplami havuzu
     *       ASAR. `rareBefore` ikisini tanim geregi esitler.
     */
    function weightOf(uint256 queryId, address account) public view returns (uint256) {
        Query storage q = _queries[queryId];
        if (q.snapshotCount == 0) revert UnknownQuery(queryId);

        uint256 weight = RarityMath.ONE_BPS;

        if (protocol.rareBefore(account, q.openedAtBlock)) {
            weight = RarityMath.multiplierBps(q.snapshotPoolCount, q.snapshotCarriers);
        }
        if (protocol.isFoundingContributor(account)) {
            weight = RarityMath.withFoundingBonus(weight);
        }
        return weight;
    }

    /**
     * @notice Anlik goruntudeki toplam agirlik — payin paydasi.
     *
     * @dev  Katilimcilar DOLASILMAZ. Dort sayac dort ayrik kumeyi verir ve
     *       toplam bu kumelerin agirliklarinin toplamidir:
     *
     *         N  = havuzdaki toplam         (`participantCount`)
     *         C  = nadir tasiyici           (`rareCarrierCount`)
     *         F  = Kurucu katkici           (min(N, FOUNDING_LIMIT) — sayilmaz)
     *         CF = nadir + Kurucu           (`rareFoundingCount`)
     *
     *         duz            = N - C - F + CF   agirlik 1,00x
     *         yalniz Kurucu  = F - CF           agirlik 1,50x
     *         yalniz tasiyici= C - CF           agirlik R
     *         ikisi birden   = CF               agirlik R x 1,5
     *
     *       Kumeler ayrik ve tam oldugu icin toplam, `weightOf`'un tum
     *       katilimcilar uzerindeki toplamina BIREBIR esittir — ayni yardimci
     *       fonksiyonlar kullanildigi surece yuvarlama farki da olusmaz.
     *
     *       KURUCU SAYISI SAYILMAZ, HESAPLANIR: kuruculuk indeks tabanlidir
     *       (`participantIndex <= FOUNDING_CONTRIBUTOR_LIMIT`), yani kurucu
     *       sayisi tanim geregi `min(N, limit)`tir. Kesisim (nadir VE kurucu)
     *       ise hesaplanamaz ve zincirde sayilir.
     */
    function _totalWeightBps(
        address researcher,
        uint32 consenting,
        uint32 poolCount,
        uint32 carriers
    ) private view returns (uint256) {
        researcher; // payda artik arastirmaciya gore degismez

        uint256 rare = protocol.rareCarrierCount();
        uint256 limit = protocol.FOUNDING_CONTRIBUTOR_LIMIT();
        uint256 founding = consenting < limit ? consenting : limit;
        uint256 both = protocol.rareFoundingCount();

        uint256 multiplier = RarityMath.multiplierBps(poolCount, carriers);

        // ISLEM SIRASI ONEMLI: `N - C - F + CF` matematiksel olarak dogru ama
        // ara adimda negatife duser (ornek: N=2, C=1, F=2, CF=1 -> "2-1-2").
        // Solidity'de bu bir tasma paniğidir. Once eklenir, sonra cikarilir.
        uint256 plain = uint256(consenting) + both - rare - founding;

        return
            plain * RarityMath.ONE_BPS +
            (founding - both) * RarityMath.withFoundingBonus(RarityMath.ONE_BPS) +
            (rare - both) * multiplier +
            both * RarityMath.withFoundingBonus(multiplier);
    }

    /**
     * @notice Sorgunun nadirlik anlik goruntusu — panel ve denetim icin.
     * @dev `multiplierBps` bu sorguda tasiyicilara uygulanan carpandir.
     */
    function queryWeights(uint256 queryId)
        external
        view
        returns (
            uint32 poolCount,
            uint32 carriers,
            uint256 multiplierBps,
            uint256 totalWeightBps
        )
    {
        Query storage q = _queries[queryId];
        if (q.snapshotCount == 0) revert UnknownQuery(queryId);
        return (
            q.snapshotPoolCount,
            q.snapshotCarriers,
            RarityMath.multiplierBps(q.snapshotPoolCount, q.snapshotCarriers),
            q.totalWeightBps
        );
    }

    /**
     * @notice Bir adresin TUM sorgulardan cekebilecegi toplam ve uygun sorgu kimlikleri.
     *
     * @dev Panel bunu tek cagriyla gosterebilsin diye var. `view` oldugu icin
     *      gaz harcamaz; zincir uzerinde CAGRILMAMALIDIR — sorgu sayisi
     *      arttikca dongusu buyur.
     */
    function pendingRewards(address account)
        external
        view
        returns (uint256 total, uint256[] memory queryIds)
    {
        uint256 count;
        for (uint256 i = 0; i < nextQueryId; i++) {
            if (claimable(i, account) > 0) count++;
        }

        queryIds = new uint256[](count);
        uint256 cursor;
        for (uint256 i = 0; i < nextQueryId; i++) {
            uint256 amount = claimable(i, account);
            if (amount > 0) {
                total += amount;
                queryIds[cursor++] = i;
            }
        }
    }

    function query(uint256 queryId)
        external
        view
        returns (
            address researcher,
            uint256 fee,
            uint256 liquidityPot,
            uint32 snapshotCount,
            uint256 openedAtBlock,
            uint256 claimedTotal,
            uint256 disclosureRequestId,
            bool settled,
            bool refunded,
            uint256 coverageTotal
        )
    {
        Query storage q = _queries[queryId];
        if (q.snapshotCount == 0) revert UnknownQuery(queryId);
        return (
            q.researcher,
            q.fee,
            q.liquidityPot,
            q.snapshotCount,
            q.openedAtBlock,
            q.claimedTotal,
            q.disclosureRequestId,
            q.settled,
            q.refunded,
            q.coverageTotal
        );
    }

    /**
     * @notice Sorgunun KITLIKLA AGIRLIKLANDIRILMIS kapsama toplami.
     *
     * @dev `query()` ham kayit sayisini doner (gosterim icin); bu, kullanim
     *      payinin gercek paydasidir. Ikisi ayri durur cunku "kac kayit
     *      alindi" ile "o kayitlar ne kadar degerliydi" farkli sorulardir.
     */
    function weightedTotal(uint256 queryId) external view returns (uint256) {
        Query storage q = _queries[queryId];
        if (q.snapshotCount == 0) revert UnknownQuery(queryId);
        return q.weightedTotal;
    }

    // ---------------------------------------------------------------------------------
    // Hazine
    // ---------------------------------------------------------------------------------

    /**
     * @notice Hazine bakiyesini cikarir.
     *
     * @dev Rapor §4.2.1: bu pay Filecoin depolama, coprocessor giderleri ve
     *      Ar-Ge icin kullanilir. Sahip URETIMDE cok imzali bir cuzdan olmalidir.
     */
    function withdrawTreasury(address to) external onlyOwner nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();

        amount = treasuryBalance;
        if (amount == 0) revert NothingToWithdraw();

        treasuryBalance = 0;
        token.safeTransfer(to, amount);
        emit TreasuryWithdrawn(to, amount);
    }

    /**
     * @notice Kapanmis sorgulardan artan bolme kusuratini hazineye tasir.
     *
     * @dev `liquidityPot / snapshotCount` tam bolunmedigi icin her sorguda en
     *      fazla `snapshotCount - 1` birim artar. Bu tutar kontratta kilitli
     *      kalirdi; tum paylar cekildikten sonra hazineye aktarilir.
     *
     *      Erken cagrilmasi zararsizdir: hak edilmemis pay tasinamaz, cunku
     *      hesap `liquidityPot - claimedTotal` degil, yalnizca TAM DAGITIM
     *      sonrasi kalan artiktir.
     */
    function sweepDust(uint256 queryId) external nonReentrant returns (uint256 dust) {
        Query storage q = _queries[queryId];
        if (q.snapshotCount == 0) revert UnknownQuery(queryId);

        uint256 perShare = q.liquidityPot / q.snapshotCount;
        uint256 distributable = perShare * q.snapshotCount;

        dust = q.liquidityPot - distributable;
        if (dust == 0) revert NothingToWithdraw();

        q.liquidityPot = distributable;
        treasuryBalance += dust;
    }
}
