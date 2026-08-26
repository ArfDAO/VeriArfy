// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, ebool, euint8, euint32, euint64, externalEuint32} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

import {BiomarkerStats} from "./libraries/BiomarkerStats.sol";
import {CoverageBits} from "./libraries/CoverageBits.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IVeriarfyProtocolGroups {
    function isEnrolled(address participant) external view returns (bool);

    function participantGroup(address participant) external view returns (euint8);
}

/**
 * @title   VeriarfyBiomarkers
 * @notice  Veri kategorisi 2 — surekli biyobelirtec ve fizyolojik telemetri.
 *
 * @dev  NE ISLER
 *
 *       VO2 max, laktat esigi, kreatin kinaz onarim hizi, giyilebilir
 *       cihazlardan gelen kardiyovaskuler metrikler. Genomik dozajin aksine
 *       bunlar SUREKLI degerlerdir; sorulan soru "vaka grubunun ORTALAMASI
 *       kontrol grubundan anlamli olcude farkli mi" olur ve testi Welch
 *       t-testidir.
 *
 *       Zincirde grup basina yalnizca UC sayi birikir: n, Sum x, Sum x^2.
 *       Bireyin olcumu hicbir zaman zincire yazilmaz. Testin kendisi bolme
 *       icerdigi icin (sifreli bolme TFHE'de pratik degildir) duz metinde
 *       yapilir — `packages/study` icindeki `compareGroups`.
 *
 *       NEDEN AYRI KONTRAT
 *
 *       `VeriarfyProtocol` EIP-170'in 24.576 baytlik sinirina dayandi. Kanal
 *       oraya eklendiginde 26.299 bayt oldu ve kontrat dagitilamaz hale geldi;
 *       optimizasyon ayarlari ve kutuphaneye tasima yetmedi. Ayrim ayrica
 *       DOGRU olan: veri kategorileri bagimsiz kanallardir. Onay ve acilim
 *       dongusu TEK yerde (protokolde) kalir, bu kontrat yalnizca veriyi
 *       tutar ve tek basina kimseye cozum yetkisi VEREMEZ.
 *
 *       SIFRELI GRUP ETIKETI NEREDEN GELIYOR
 *
 *       Katilimci gruba protokolde kaydolur. Protokol, kayit aninda etiketin
 *       kullanim iznini bu kontrata verir (`FHE.allow`). Bu yuzden modul ILK
 *       KAYITTAN ONCE baglanmis olmalidir; `setBiomarkerModule` bunu zorlar.
 *
 *       ISTEMCI NOTU: girdi kaniti kontrat adresine baglidir. Olcumler BU
 *       kontratin adresi icin sifrelenir, protokolunki icin degil.
 */
contract VeriarfyBiomarkers is ZamaEthereumConfig, Ownable, ReentrancyGuard {
    // ---------------------------------------------------------------------------------
    // Hatalar
    // ---------------------------------------------------------------------------------

    error NotProtocol(address caller);
    error NotEnrolled(address participant);
    error EmptyBatch();
    error EmptyMetricPanel();
    error MetricsFrozen();
    error TooManyMetrics(uint32 requested, uint32 available);
    error InvalidMetricScale(uint32 index);
    error InvalidMetricRange(uint32 index, uint32 minValue, uint32 maxValue);
    error MetricOutsideWindow(uint32 metric, uint32 from, uint32 to);
    error InvalidMetricWindow(uint32 requested, uint32 maximum);
    error ZeroAddress();

    // ---------------------------------------------------------------------------------
    // Olaylar
    // ---------------------------------------------------------------------------------

    event MetricsConfigured(uint32 metricCount, bytes32 metricsHash, string metricsUri);
    /// @dev `covered`: bu partide ILK KEZ kapsanan metrik sayisi.
    event BiomarkersContributed(
        address indexed participant,
        uint32 fromMetric,
        uint32 toMetric,
        uint32 covered
    );
    event BiomarkerPanelCompleted(address indexed participant);
    event BiomarkerSnapshotTaken(uint256 indexed requestId, uint32 metricCount);

    // ---------------------------------------------------------------------------------
    // Sabitler
    // ---------------------------------------------------------------------------------

    /// @notice Kontrol (saglikli) grubu — protokoldeki degerle AYNI olmalidir.
    uint8 public constant GROUP_CONTROL = 0;

    /// @notice Vaka (hasta) grubu.
    uint8 public constant GROUP_CASE = 1;

    /**
     * @notice Eksik olcum isareti — SIFIR.
     *
     * @dev  NEDEN 0 GUVENLE "EKSIK" DEMEK
     *
     *       Genomik tarafta 0 gecerli bir dozajdir ("homozigot referans"), bu
     *       yuzden eksik veri icin ayri bir isaret (`DOSAGE_MISSING = 3`)
     *       gerekti. Burada durum tersidir: metrikler FIZYOLOJIK olcumlerdir
     *       ve olcekli sifir hicbirinde gecerli degildir — VO2 max 0, kalp
     *       hizi 0 ya da laktat 0 canli bir insanda olcum degil, olcumun
     *       YOKLUGUDUR.
     *
     *       Bu kural varsayim olarak birakilmaz, ZORLANIR: `configureMetrics`
     *       her metrigin `minValue` degerinin en az 1 olmasini sart kosar.
     *       Boylece 0 gecerli araligin disinda kalir ve tek bir kural yeter:
     *       "arali disi olcum = eksik".
     *
     *       Bedava gelmesinin sebebi de bu: aralik kontrolu zaten yapiliyor
     *       (kotu niyetli girdiye karsi), eksiklik ayri bir islem gerektirmez.
     *       Ayri bir "var/yok" bayragi gonderilseydi her metrik icin fazladan
     *       bir sifreli girdi ve bir karsilastirma odenirdi.
     */
    uint32 public constant BIOMARKER_MISSING = 0;

    /**
     * @notice Bir metrigin alabilecegi en buyuk OLCEKLI deger (2^20 - 1).
     *
     * @dev  NEDEN SINIR VAR — SIFRELI ARITMETIK TASMADA REVERT ETMEZ
     *
     *       Homomorfik toplama sessizce sarar (wrap): `euint64` tasarsa hata
     *       alinmaz, yalnizca yanlis sonuc birikir. Dolayisiyla tasmama,
     *       kodda dogrulanabilir bir SINIR olarak durmak zorundadir.
     *
     *       Kareler toplami en hizli buyuyen terimdir:
     *
     *           x_max   = 1.048.575          (2^20 - 1)
     *           x_max^2 ~ 1,10 * 10^12
     *           uint64  ~ 1,84 * 10^19
     *           => ~16.700.000 katilimci tasma olmadan toplanabilir.
     *
     *       Toplamin kendisi (Sum x) cok daha gec tasar; baglayici kisit
     *       kareler toplamidir.
     *
     *       Sinir pratikte darlik yaratmaz cunku her metrik KENDI olcegini
     *       secer: VO2 max 90,0 ml/kg/dk -> olcek 100 -> 9.000; laktat
     *       20,00 mmol/L -> olcek 1000 -> 20.000; kreatin kinaz 200.000 U/L
     *       -> olcek 1 -> 200.000. Ucu de sinirin altindadir.
     */
    uint32 public constant MAX_METRIC_VALUE = 1_048_575;

    /**
     * @notice Tek bir acilim talebinin kapsayabilecegi en fazla metrik.
     *
     * @dev Metrik basina 6 handle (2 grup x {toplam, kareler toplami, sayim})
     *      kopyalanir — protokoldeki SNP penceresiyle ayni buyukluk, ayni
     *      gerekce: sinirsiz birakmak talebi blok gaz limitine carptirir.
     */
    uint32 public constant MAX_METRIC_WINDOW = 16;

    // ---------------------------------------------------------------------------------
    // Metrik paneli
    // ---------------------------------------------------------------------------------

    /**
     * @notice Tek bir metrigin zincirdeki tanimi.
     *
     * @dev  NEDEN ARALIK VE OLCEK ZINCIRDE DURUYOR
     *
     *       Aralik zorunlu: eleme ZINCIRDE yapilir, sozlesme
     *       `minValue`/`maxValue` degerlerini homomorfik karsilastirmada
     *       kullanir. Disarida tutulsalardi zorlanan sinir ile ilan edilen
     *       sinir birbirinden sessizce ayrilabilirdi.
     *
     *       `scale` hesaba girmez ama burada durur: birimi olmayan bir
     *       tamsayi anlamsizdir. "Alice ml/kg/dk, Bob L/dk gonderdi" hatasi,
     *       MK-0013'te genomik tarafta duzeltilen hizasizlik hatasinin
     *       AYNISIDIR. Olcek ve birim zincirde ilan edilir ki istemci kendi
     *       donusumunu dogrulayabilsin.
     */
    struct MetricSpec {
        /// @dev Metrik kimligi (ornegin LOINC kodu) — tam tanim `metricsUri`'de.
        bytes32 code;
        /// @dev Birim etiketi, ornegin `"ml/kg/min"`. Insan ve istemci icin.
        bytes32 unit;
        /// @dev Olcek: kodlanmis = gercek * scale + offset. Sifir olamaz.
        uint32 scale;
        /**
         * @dev SIFIR NOKTASI — isaretli buyukluklerin kodlanmasi.
         *
         * Kodlanmis degerler `uint32`'dir ve `minValue >= 1` zorunlulugu
         * yuzunden NEGATIF olamaz. Ama gercek verinin bir kismi isaretlidir:
         * kreatin kinaz ONARIM HIZI normalde bir DUSUSTUR (negatif egim),
         * HRV egilimi negatif olabilir.
         *
         * Cozum kaydirma: `kodlanmis = gercek * scale + offset`. Yalnizca
         * pozitif metrikler icin `offset = 0`.
         *
         * ISTATISTIGE ETKISI YOK — ve bu tesaduf degil:
         *
         *     ortalama(kodlanmis) = ortalama(gercek) * scale + offset
         *     varyans(kodlanmis)  = varyans(gercek) * scale^2   (offset DUSER)
         *
         * t = ortalama farki / standart hata oldugu icin offset paydada da
         * paydada da yok olur ve `scale` sadelesir: t ve p degeri kodlanmis
         * degerlerden hesaplandiginda gercek degerlerden hesaplananla
         * BIREBIR AYNIDIR. Yalnizca raporlanan ortalama farki ve guven
         * araligi geri cevrilmelidir.
         */
        uint32 offset;
        /// @dev Gecerli olcekli alt sinir (dahil). EN AZ 1 — bkz. `BIOMARKER_MISSING`.
        uint32 minValue;
        /// @dev Gecerli olcekli ust sinir (dahil). En fazla `MAX_METRIC_VALUE`.
        uint32 maxValue;
    }

    /// @notice Protokol — grup etiketi ve yetki oradan gelir.
    IVeriarfyProtocolGroups public immutable protocol;

    /// @dev Calismanin metrik listesi; sira ANLAM TASIR (indeks = metrik kimligi).
    MetricSpec[] private _metrics;

    /// @dev `[metrik][grup]` -> yeterli istatistikler.
    mapping(uint32 metric => BiomarkerStats.Accumulator[2]) private _live;

    /// @dev `[talep][metrik][grup]` -> dondurulmus toplamlar.
    mapping(uint256 requestId => mapping(uint32 => BiomarkerStats.Accumulator[2])) private _frozen;

    /// @dev Talepte SECILEN metrikler — aralik degil liste.
    mapping(uint256 requestId => uint32[]) private _snapshotIds;

    /// @dev Metrigin akumulatorleri baslatildi mi?
    mapping(uint32 => bool) private _metricInitialized;

    /**
     * @notice Katilimcinin su ana kadar gonderdigi metrik sayisi.
     *
     * @dev Dozajlarla ayni sirali parti mantigi: bir sonraki parti tam olarak
     *      bu indeksten baslar; ne bosluk kalir ne cift sayim.
     */
    mapping(address => uint32) public submittedMetrics;

    /// @dev Ilk katkidan sonra panel degistirilemez.
    bool public panelFrozen;

    /**
     * @notice `katilimci => kelime => bitler`. Bit, o metrikte GERCEK olcum demek.
     *
     * @dev Genomik taraftaki ile ayni gerekce (bkz. `CoverageBits`): odeme
     *      KULLANILAN ALANA gore dagitilir, bu yuzden kapsama duz metin
     *      olmak zorunda.
     *
     *      Kullanici beyan etmez: olcum girilmediyse `BIOMARKER_MISSING` (0)
     *      gonderilir ve maske o degerden turetilir.
     */
    mapping(address => mapping(uint256 => uint256)) private _metricCoverage;

    /// @notice `metrik => o olcumu vermis katilimci sayisi` (odemenin paydasi).
    mapping(uint32 => uint32) public metricCoverageCount;

    /**
     * @notice Metrik tanim belgesinin ozeti (`metricsUri` icerigi).
     *
     * @dev Sayisal sinirlar zincirde `_metrics` icinde durdugu icin bu ozet
     *      SINIRLARIN degil, TANIMIN kanitidir: olcum protokolu (hangi test,
     *      hangi kosulda), birim tanimi, LOINC eslesmeleri. Iki calisma ayni
     *      araligi ilan edip farkli protokolle olcerse sayilar yine
     *      karsilastirilamaz — ozet bu farki gorunur kilar.
     */
    bytes32 public metricsHash;

    /// @notice Metrik tanim belgesine erisim adresi (IPFS CID ya da URL).
    string public metricsUri;

    modifier onlyProtocol() {
        if (msg.sender != address(protocol)) revert NotProtocol(msg.sender);
        _;
    }

    constructor(address protocol_) Ownable(msg.sender) {
        if (protocol_ == address(0)) revert ZeroAddress();
        protocol = IVeriarfyProtocolGroups(protocol_);
    }

    // ---------------------------------------------------------------------------------
    // Panel
    // ---------------------------------------------------------------------------------

    /**
     * @notice Calismanin metrik panelini yapilandirir.
     *
     * @dev ILK KATKIDAN SONRA DEGISTIRILEMEZ. Yarida degisen bir tanim, kimi
     *      katilimcinin eski kimi yeni araliga gore elendigi tutarsiz
     *      toplamlar birakirdi.
     *
     * @param specs        Sirali metrik listesi; SIRA metrik kimligidir.
     * @param metricsHash_ Metrik tanim belgesinin ozeti.
     * @param metricsUri_  Belgenin adresi (IPFS CID ya da URL).
     */
    function configureMetrics(
        MetricSpec[] calldata specs,
        bytes32 metricsHash_,
        string calldata metricsUri_
    ) external onlyOwner {
        if (panelFrozen) revert MetricsFrozen();
        if (specs.length == 0) revert EmptyMetricPanel();

        delete _metrics;

        for (uint32 i = 0; i < specs.length; ++i) {
            MetricSpec calldata spec = specs[i];

            if (spec.scale == 0) revert InvalidMetricScale(i);

            // `minValue >= 1` SART: 0'in eksik isareti olabilmesi icin gecerli
            // araligin disinda kalmasi gerekir (bkz. `BIOMARKER_MISSING`).
            //
            // `min > max` de yasak: oyle bir metrik hicbir degeri kabul etmez
            // ve HER olcumu sessizce "eksik" sayardi — panel dogru gorunurken
            // o sutun bos kalirdi.
            if (
                spec.minValue == 0 ||
                spec.minValue > spec.maxValue ||
                spec.maxValue > MAX_METRIC_VALUE
            ) {
                revert InvalidMetricRange(i, spec.minValue, spec.maxValue);
            }

            _metrics.push(spec);
        }

        metricsHash = metricsHash_;
        metricsUri = metricsUri_;

        emit MetricsConfigured(uint32(specs.length), metricsHash_, metricsUri_);
    }

    /// @notice Calismanin metrik sayisi.
    function metricCount() public view returns (uint32) {
        return uint32(_metrics.length);
    }

    /// @notice Bir metrigin zincirdeki tanimi (istemci donusumunu buna gore yapar).
    function metricAt(uint32 index) external view returns (MetricSpec memory) {
        if (index >= _metrics.length) revert TooManyMetrics(index + 1, metricCount());
        return _metrics[index];
    }

    /// @notice Katilimcinin ISTENEN metriklerden kacinda gercek olcumu var?
    function metricCoverageWeight(
        address participant,
        uint32[] calldata metricIds
    ) external view returns (uint32) {
        return CoverageBits.weight(_metricCoverage, participant, metricIds);
    }

    /// @notice Istenen metriklerin kapsama sayaclari toplami — odemenin PAYDASI.
    function metricCoverageTotal(uint32[] calldata metricIds) external view returns (uint256) {
        return CoverageBits.total(metricCoverageCount, metricIds);
    }

    /**
     * @notice Istenen metriklerin hangilerinde olcumu oldugu — BIT MASKESI.
     *
     * @dev Bit i, `metricIds[i]` alanina karsilik gelir. Genomik taraftaki
     *      `snpCoverageMask` ile ayni amac: kitliga gore agirliklandirma
     *      alan basina harici cagri yapmak zorunda kalmasin.
     */
    function metricCoverageMask(
        address participant,
        uint32[] calldata metricIds
    ) external view returns (uint256) {
        return CoverageBits.maskOf(_metricCoverage, participant, metricIds);
    }

    /// @notice Katilimcinin bu metrikte gercek olcumu var mi?
    function hasMetricCoverage(address participant, uint32 metric) external view returns (bool) {
        return CoverageBits.has(_metricCoverage, participant, metric);
    }

    /// @notice Katilimci metrik panelini TAMAMLADI mi?
    function hasBiomarkerPanel(address participant) external view returns (bool) {
        return _metrics.length > 0 && submittedMetrics[participant] == _metrics.length;
    }

    // ---------------------------------------------------------------------------------
    // Katki
    // ---------------------------------------------------------------------------------

    /**
     * @notice Bir sonraki metrik dilimi icin sifreli olcumleri gonderir.
     *
     * @dev  NEDEN PARTILI — HCU BUTCESI, GAZ DEGIL
     *
     *       Dozajlarda kisit blok gaziydi. Burada baglayici olan fhEVM'in
     *       ISLEM BASINA HOMOMORFIK HESAP BUTCESIDIR (HCU):
     *       `MAX_HOMOMORPHIC_COMPUTE_UNITS_PER_TX = 20.000.000`.
     *
     *       Metrik basina en pahali islem kareyi almaktir:
     *       `mul(euint64, euint64)` tek basina 596.000 HCU'dur — dozajda boyle
     *       bir carpma HIC yoktu.
     *
     *       OLCULEN TAVAN: islem basina 8 METRIK (`test/BiomarkerHcu.test.ts`;
     *       9-10 metrikte `HCUTransactionLimitExceeded`). Metrik basina
     *       ~653.000 gaz, yani ~2,4M HCU. Karsilastirma icin dozaj tavani 12
     *       SNP'ydi — fark tam olarak karesini alma isleminden geliyor.
     *
     *       Gercek bir biyobelirtec paneli 5-40 metriktir; 40 metrik ~5 islem
     *       eder ve bu 1000 SNP'lik genomik panelin yaninda kucuktur. Parti
     *       buyuklugunu yine CAGIRAN secer, cunku butce aga gore degisebilir.
     *
     *       NEDEN ZAMAN SERISI HAM HALIYLE SIFRELENMIYOR
     *
     *       Giyilebilir bir cihaz 1 Hz'de gunde 86.400 ornek uretir. Islem
     *       basina 8 ornek, gunluk 10.800 islem demektir: fiziksel olarak
     *       imkansiz — ve BILIMSEL OLARAK DA GEREKSIZ. VO2 max zaten ham nefes
     *       verisi degil, bir rampa testinden TURETILEN bir metriktir; laktat
     *       esigi bir egriden okunur; kreatin kinaz onarim hizi iki olcum
     *       arasindaki egimdir.
     *
     *       Bu yuzden zaman serisi indirgemesi ISTEMCIDE yapilir (bkz.
     *       `web/src/lib/metrics.ts`) ve zincire donemsel metrik girer.
     *
     *       DURUST SINIR: bu indirgemenin dogru yapildigi zincirde
     *       KANITLANMAZ. Sozlesmenin zorladigi tek sey araliktir — tipki beyan
     *       edilen herhangi bir olcum gibi. Kanitli indirgeme ZK gerektirir ve
     *       kapsam disidir.
     *
     * @param encValues Sirali olcekli olcumler; `submittedMetrics[msg.sender]`
     *        indeksinden baslar. Olculmemis metrik icin `BIOMARKER_MISSING`.
     */
    function contributeBiomarkers(
        externalEuint32[] calldata encValues,
        uint256 coverageMask,
        bytes calldata inputProof
    ) external nonReentrant {
        if (!protocol.isEnrolled(msg.sender)) revert NotEnrolled(msg.sender);
        if (encValues.length == 0) revert EmptyBatch();

        uint32 start = submittedMetrics[msg.sender];
        uint32 end = start + uint32(encValues.length);
        uint32 total = metricCount();
        if (end > total) revert TooManyMetrics(end, total);

        panelFrozen = true;

        // Grup karsilastirmalari PARTI BASINA BIR KEZ — metrik basina
        // tekrarlanmasi gereksiz iki bootstrapping olurdu.
        euint8 group = protocol.participantGroup(msg.sender);
        ebool[2] memory inGroup;
        inGroup[GROUP_CONTROL] = FHE.eq(group, GROUP_CONTROL);
        inGroup[GROUP_CASE] = FHE.eq(group, GROUP_CASE);

        for (uint256 i = 0; i < encValues.length; ++i) {
            _accumulate(start + uint32(i), encValues[i], inputProof, inGroup);
        }

        submittedMetrics[msg.sender] = end;
        _recordCoverage(start, end, coverageMask, encValues.length);

        if (end == total) emit BiomarkerPanelCompleted(msg.sender);
    }

    /**
     * @dev Kapsama yazimi AYRI fonksiyonda — sebep yine derleyici.
     *
     *      Govde cagiran fonksiyonun icindeyken solc "Stack too deep" veriyor:
     *      EVM'in 16 slotluk erisilebilir yigin penceresi doluyor.
     *
     *      Ne yaptigi: hangi metrikte GERCEK olcum oldugunu isaretler. Sifreli
     *      degerden cikarilamaz (sifreli olmasinin anlami budur), istemcinin
     *      doldurdugu alanlardan turetilir.
     */
    function _recordCoverage(
        uint32 start,
        uint32 end,
        uint256 coverageMask,
        uint256 length
    ) private {
        uint32 covered = CoverageBits.record(
            _metricCoverage,
            metricCoverageCount,
            msg.sender,
            start,
            coverageMask,
            length
        );
        emit BiomarkersContributed(msg.sender, start, end, covered);
    }

    /**
     * @dev Tek metrigin islenmesi AYRI bir fonksiyondadir.
     *
     *      Sebep derleyicidir, uslup degil: dongunun govdesi cagiran fonksiyonun
     *      icindeyken solc "Stack too deep" veriyor — EVM'in 16 slotluk
     *      erisilebilir yigin penceresi doluyor. Govdeyi ayirmak yerel
     *      degiskenleri kendi cercevesine tasir.
     */
    function _accumulate(
        uint32 metric,
        externalEuint32 encValue,
        bytes calldata inputProof,
        ebool[2] memory inGroup
    ) private {
        if (!_metricInitialized[metric]) {
            BiomarkerStats.initialize(_live, metric);
            _metricInitialized[metric] = true;
        }

        MetricSpec storage spec = _metrics[metric];

        BiomarkerStats.accumulate(
            _live,
            metric,
            FHE.fromExternal(encValue, inputProof),
            spec.minValue,
            spec.maxValue,
            inGroup[GROUP_CONTROL],
            inGroup[GROUP_CASE]
        );
    }

    // ---------------------------------------------------------------------------------
    // Acilim — yalnizca protokolden
    // ---------------------------------------------------------------------------------

    /// @notice Varsayilan acilim penceresi — protokol bunu okur.
    function disclosureWindowSize() external view returns (uint32) {
        uint32 total = metricCount();
        return total > MAX_METRIC_WINDOW ? MAX_METRIC_WINDOW : total;
    }

    /**
     * @notice Talep icin toplamlari dondurur.
     *
     * @dev Kontenjans tablosuyla ayni gerekce: talep acildiktan sonra yeni
     *      katilimcilar gelmeye devam eder. Onaylayan dugumlerin gordugu
     *      sayilar, oy verdikleri sayilar olmalidir.
     */
    function snapshotFor(
        uint256 requestId,
        uint32[] calldata metricIds
    ) external onlyProtocol {
        if (metricIds.length == 0 || metricIds.length > MAX_METRIC_WINDOW) {
            revert InvalidMetricWindow(uint32(metricIds.length), MAX_METRIC_WINDOW);
        }

        uint32 total = metricCount();
        for (uint256 i = 0; i < metricIds.length; ++i) {
            uint32 metric = metricIds[i];
            if (metric >= total) revert TooManyMetrics(metric + 1, total);

            _snapshotIds[requestId].push(metric);
            BiomarkerStats.snapshot(_live, _frozen[requestId], metric);
        }

        emit BiomarkerSnapshotTaken(requestId, uint32(metricIds.length));
    }

    /// @notice Talepte secilen metrikler.
    function snapshotIds(uint256 requestId) external view returns (uint32[] memory) {
        return _snapshotIds[requestId];
    }

    /**
     * @notice Dondurulmus toplamlarin cozum yetkisini arastirmaciya verir.
     *
     * @dev Yalnizca protokol cagirabilir; yani esik, itiraz suresi ve iptal
     *      kontrollerinin TAMAMI zaten gecilmis demektir. Bu kontratin kendi
     *      basina yetki verebilmesi, tum onay mekanizmasini atlatirdi.
     */
    function grantFor(uint256 requestId, address researcher) external onlyProtocol {
        uint32[] storage ids = _snapshotIds[requestId];
        for (uint256 i = 0; i < ids.length; ++i) {
            BiomarkerStats.grant(_frozen[requestId], ids[i], researcher);
        }
    }

    // ---------------------------------------------------------------------------------
    // Okuma
    // ---------------------------------------------------------------------------------

    /**
     * @notice Bir metrigin CANLI sifreli toplamlari.
     *
     * @dev Handle dondurur; cozmek icin ayrica ACL izni gerekir ve o izin
     *      yalnizca esikli acilimla verilir.
     */
    function biomarkerAggregate(
        uint32 metric,
        uint8 group
    ) external view returns (euint64 sum, euint64 sumSq, euint32 count) {
        if (metric >= _metrics.length) revert TooManyMetrics(metric + 1, metricCount());
        BiomarkerStats.Accumulator storage acc = _live[metric][group];
        return (acc.sum, acc.sumSq, acc.count);
    }

    /**
     * @notice Talebin dondurdugu toplamlar — Welch t-testinin girdisi.
     *
     * @dev Grup basina (n, Sum x, Sum x^2).
     */
    function disclosureBiomarkerAt(
        uint256 requestId,
        uint32 metric,
        uint8 group
    ) external view returns (euint64 sum, euint64 sumSq, euint32 count) {
        uint32[] storage ids = _snapshotIds[requestId];
        bool selected = false;
        for (uint256 i = 0; i < ids.length; ++i) {
            if (ids[i] == metric) {
                selected = true;
                break;
            }
        }
        if (!selected) revert MetricOutsideWindow(metric, 0, uint32(ids.length));

        BiomarkerStats.Accumulator storage acc = _frozen[requestId][metric][group];
        return (acc.sum, acc.sumSq, acc.count);
    }
}
