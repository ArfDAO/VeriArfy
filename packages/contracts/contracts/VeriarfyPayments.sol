// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {RarityMath} from "./libraries/RarityMath.sol";

interface IVeriarfyProtocol {
    function participantIndex(address account) external view returns (uint32);
    /// @notice Havuzun tamami ve dogrulanmis nadir tasiyici sayisi (rapor §4.3).
    function rarityStats() external view returns (uint32 poolCount, uint32 carriers);
    /// @notice Izin ANINDA dondurulmus nadirlik durumu.
    function rareAtGrant(address participant, address researcher) external view returns (bool);
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
    /// @notice Talebin esigi saglandi mi (BSKK-44 onayi tamam mi)?
    function isDisclosureGranted(uint256 requestId) external view returns (bool);
    /// @notice Bu arastirmaciya su an izin veren katilimci sayisi.
    function consentCount(address researcher) external view returns (uint32);
    /// @notice Izin, verilen blokta yururlukte miydi?
    function hasAccessAt(address participant, address researcher, uint256 blockNumber)
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
    event PricingUpdated(uint256 baseFee, uint256 perParticipantFee);

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

    /// @notice Katilimci basina ek ucret — "hesaplama basina odeme" bileseni.
    uint256 public perParticipantFee;

    // ---------------------------------------------------------------------------------
    // Sorgu kayitlari
    // ---------------------------------------------------------------------------------

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
        uint256 perParticipantFee_
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

        baseFee = baseFee_;
        perParticipantFee = perParticipantFee_;
        emit PricingUpdated(baseFee_, perParticipantFee_);
    }

    // ---------------------------------------------------------------------------------
    // Fiyatlandirma
    // ---------------------------------------------------------------------------------

    /**
     * @notice Su an bir sorgu acmanin maliyeti.
     *
     * @dev "Hesaplama basina odeme": maliyet, sorgunun dokunacagi katilimci
     *      sayisiyla dogrusal artar. Homomorfik islem derinligi henuz fiyata
     *      girmiyor — devre tipi tek oldugu icin sabit; farkli devreler
     *      eklendiginde carpan buraya gelir.
     */
    function quote() public view returns (uint256 fee, uint32 participants) {
        return quoteFor(msg.sender);
    }

    /**
     * @notice Belirli bir arastirmaci icin ucret.
     *
     * @dev Katilimci sayisi HAVUZUN TAMAMI degil, **bu arastirmaciya izin
     *      vermis** kisi sayisidir. Rapor §3.4'un dogal sonucu: izin vermeyen
     *      kisinin verisi kullanilmaz, dolayisiyla ucretlendirilmez ve o kisi
     *      pay almaz.
     */
    function quoteFor(address researcher) public view returns (uint256 fee, uint32 participants) {
        participants = protocol.consentCount(researcher);
        fee = baseFee + perParticipantFee * participants;
    }

    function setPricing(uint256 baseFee_, uint256 perParticipantFee_) external onlyOwner {
        baseFee = baseFee_;
        perParticipantFee = perParticipantFee_;
        emit PricingUpdated(baseFee_, perParticipantFee_);
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
    function openQuery(uint8 queryType) external nonReentrant returns (uint256 queryId) {
        if (!researchers.isRegistered(msg.sender)) {
            revert NotRegisteredResearcher(msg.sender);
        }

        (uint256 fee, uint32 participants) = quoteFor(msg.sender);
        // Kimse izin vermemisse sorgu acilamaz: dagitilacak kimse yokken
        // ucret tahsil etmek, ucretin tamaminin hazineye gitmesi demek olurdu.
        if (participants == 0) revert PoolEmpty();

        // Once transfer, sonra durum: token transferi basarisiz olursa kayit
        // olusmasin. `SafeERC20` donus degeri olmayan token'lari da dogru
        // isler (USDT gibi standarda tam uymayan uygulamalar mevcut).
        token.safeTransferFrom(msg.sender, address(this), fee);

        // Acilim talebi — esigi protokol, sorgu tipine gore hesaplar.
        uint256 requestId = protocol.requestDisclosure(msg.sender, queryType);

        // Nadirlik anlik goruntusu (rapor §4.3). Carpanin girdisi HAVUZUN
        // TAMAMIDIR; izin verenlerin sayisi degil — nadirlik, varyantin
        // populasyondaki gercek seyrekligidir.
        (uint32 poolCount, uint32 carriers) = protocol.rarityStats();

        queryId = nextQueryId++;
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
        if (protocol.participantIndex(msg.sender) == 0) revert NotAParticipant(msg.sender);
        if (!protocol.hasAccessAt(msg.sender, q.researcher, q.openedAtBlock)) {
            revert NotInThisQuery(msg.sender, 0, q.snapshotCount);
        }

        // Tutar `claimable` ile AYNI ifadeden gelmelidir. Iki yerde ayri ayri
        // yazilsaydi (bir kere burada, bir kere gorunumde) panelde gosterilen
        // ile odenen sessizce ayrisirdi — nitekim nadirlik agirliklari
        // eklenirken tam bu oldu ve test yakaladi.
        amount = (q.liquidityPot * weightOf(queryId, msg.sender)) / q.totalWeightBps;

        hasClaimed[queryId][msg.sender] = true;
        q.claimedTotal += amount;

        token.safeTransfer(msg.sender, amount);
        emit RewardClaimed(queryId, msg.sender, amount);
    }

    /** @notice Bir adresin belirli bir sorgudan cekebilecegi tutar (0 = uygun degil). */
    function claimable(uint256 queryId, address account) public view returns (uint256) {
        Query storage q = _queries[queryId];
        if (q.snapshotCount == 0 || hasClaimed[queryId][account]) return 0;
        // Onay gelmeden pay hesaplanmaz: ucret henuz emanettedir.
        if (!q.settled) return 0;
        if (protocol.participantIndex(account) == 0) return 0;
        if (!protocol.hasAccessAt(account, q.researcher, q.openedAtBlock)) return 0;

        // Payda sifir olamaz: `snapshotCount > 0` ise en az bir izin veren
        // vardir ve her agirlik en az `ONE_BPS`'tir.
        return (q.liquidityPot * weightOf(queryId, account)) / q.totalWeightBps;
    }

    /**
     * @notice Bir katilimcinin BELIRLI BIR SORGUDAKI agirligi (baz puan).
     *
     * @dev  Nadirlik durumu `rareAtGrant` uzerinden okunur, guncel durumdan
     *       DEGIL. Sebep: paydayi olusturan sayaclar da izin anindaki duruma
     *       gore tutulur; ikisi ayni kaynaktan beslenmezse paylarin toplami
     *       havuzu asabilir.
     *
     *       `hasAccessAt` zaten `grantedAtBlock <= openedAtBlock` sartini
     *       arar; dolayisiyla burada okunan izin, sorgu acildiginda yururlukte
     *       olan iznin ta kendisidir. Sonradan yenilenen bir izin eski
     *       sorgulari etkilemez cunku o sorgularda hakedis zaten dusar.
     */
    function weightOf(uint256 queryId, address account) public view returns (uint256) {
        Query storage q = _queries[queryId];
        if (q.snapshotCount == 0) revert UnknownQuery(queryId);

        uint256 weight = RarityMath.ONE_BPS;

        if (protocol.rareAtGrant(account, q.researcher)) {
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
     * @dev  Izin verenler DOLASILMAZ. Dort sayac dort ayrik kumeyi verir ve
     *       toplam bu kumelerin agirliklarinin toplamidir:
     *
     *         N  = izin veren toplam        (`consentCount`)
     *         C  = izin veren tasiyici      (`consentRareCount`)
     *         F  = izin veren Kurucu        (`consentFoundingCount`)
     *         CF = izin veren tasiyici+Kurucu
     *
     *         duz            = N - C - F + CF   agirlik 1,00x
     *         yalniz Kurucu  = F - CF           agirlik 1,50x
     *         yalniz tasiyici= C - CF           agirlik R
     *         ikisi birden   = CF               agirlik R x 1,5
     *
     *       Kumeler ayrik ve tam oldugu icin toplam, `weightOf`'un tum izin
     *       verenler uzerindeki toplamina BIREBIR esittir — ayni yardimci
     *       fonksiyonlar kullanildigi surece yuvarlama farki da olusmaz.
     */
    function _totalWeightBps(
        address researcher,
        uint32 consenting,
        uint32 poolCount,
        uint32 carriers
    ) private view returns (uint256) {
        uint256 rare = protocol.consentRareCount(researcher);
        uint256 founding = protocol.consentFoundingCount(researcher);
        uint256 both = protocol.consentRareFoundingCount(researcher);

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
            bool refunded
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
            q.refunded
        );
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
