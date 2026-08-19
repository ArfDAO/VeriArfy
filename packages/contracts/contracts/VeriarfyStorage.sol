// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title   VeriarfyStorage
 * @notice  Filecoin depolama anlasmalarinin zincir uzerindeki defteri ve
 *          kalicilik politikasi — rapor §2.9.2 ve WBS 2.3.
 *
 * @dev
 * # Neden var
 *
 * IPFS veriyi ADRESLER, saklamayi GARANTI ETMEZ: pinlenmemis bir blok garbage
 * collection ile silinir. Rapor §2.9.2'nin dedigi gibi tibbi arastirmada bu
 * kabul edilemez. Filecoin, ustune ekonomik tesvik katmani koyar: madenciler
 * veriyi sildiklerini gizleyemez (PoSt/PoRep), silerlerse FIL yakilir.
 *
 * Bugun sistemde blob'lar IPFS'e pinleniyor (Pinata) ama **hicbir Filecoin
 * anlasmasi yok**. Bu sozlesme o boslugun zincirdeki yarisini kapatir.
 *
 * # NEYIN GARANTI EDILDIGI — durustce
 *
 * Bu sozlesme iki farkli seyi yapar ve ikisinin guven modeli AYRIDIR:
 *
 *   1. **Politika — guvensiz (trustless).** "En az 3 farkli saglayici",
 *      "en az 180 gun", "ayni anlasma iki kez sayilamaz", "yenileme ne zaman
 *      gerekir" kurallarinin tamami burada zorlanir. Kimse bu kurallari
 *      esneterek bir CID'i yeterince cogaltilmis gosteremez.
 *
 *   2. **Olgu — tanikli (attested).** "Filecoin'de gercekten boyle bir
 *      anlasma var mi" sorusu Filecoin zincirinde yasar; Ethereum bunu
 *      goremez. Anlasmalari bir tanik (`attestor`) kaydeder.
 *
 * Ikinci maddeyi guvensiz yapmanin yolu bir Filecoin isik istemcisi ya da
 * kopru olurdu; ikisi de bu projenin kapsaminin cok disinda. Bunu gizlemek
 * yerine YALANI TESPIT EDILEBILIR kildik: her kayit `dealId` icerir ve
 * `scripts/verify-storage-deals.ts` bunu Filecoin'in **herkese acik**
 * RPC'sinden (`StateMarketStorageDeal`) dogrular. Tanik yalan soylerse
 * kimlik bilgisi gerektirmeyen bir betikle herkes yakalayabilir.
 *
 * # Filecoin epoch'u neden oracle gerektirmiyor
 *
 * Filecoin epoch'lari SABIT 30 saniyedir ve genesis zaman damgasi bilinir.
 * Dolayisiyla guncel epoch `block.timestamp`'ten aritmetikle turetilir —
 * hicbir oracle'a, hicbir tanik beyanina gerek yoktur. Genesis ve epoch
 * suresi `immutable` olarak verilir ki Calibration test agi da
 * kullanilabilsin.
 */
contract VeriarfyStorage is Ownable {
    // ---------------------------------------------------------------------------------
    // Hatalar
    // ---------------------------------------------------------------------------------

    error ZeroAddress();
    error NotAttestor(address caller);
    error EmptyCid();
    error DealTooShort(uint64 duration, uint64 minimum);
    error DealAlreadyRegistered(uint64 dealId);
    error ProviderAlreadyStores(bytes32 cidDigest, uint64 providerId);
    error UnknownDeal(uint64 dealId);
    error DealAlreadyTerminated(uint64 dealId);
    error EndBeforeStart(uint64 startEpoch, uint64 endEpoch);

    // ---------------------------------------------------------------------------------
    // Olaylar
    // ---------------------------------------------------------------------------------

    event AttestorUpdated(address indexed attestor);
    event DealRegistered(
        bytes32 indexed cidDigest,
        uint64 indexed dealId,
        uint64 indexed providerId,
        uint64 startEpoch,
        uint64 endEpoch
    );
    event DealTerminated(bytes32 indexed cidDigest, uint64 indexed dealId, string reason);
    /// @dev Zincir disi yenileme ajani bu olayi dinler (WBS 2.3 "auto-renewal").
    event RenewalRequired(bytes32 indexed cidDigest, uint32 activeReplicas, uint64 atEpoch);
    event ReplicationRestored(bytes32 indexed cidDigest, uint32 activeReplicas);

    // ---------------------------------------------------------------------------------
    // Politika sabitleri — rapor WBS 2.3
    // ---------------------------------------------------------------------------------

    /**
     * @notice En az kac farkli saglayicida durmali (rapor WBS 2.3: "en az 3").
     * @dev Rapor ayrica "farkli cografi bolgelerde" diyor. Cografya zincirde
     *      DOGRULANAMAZ — saglayici kimligi bir aktor numarasidir, konum degil.
     *      Zorlanan sey saglayicilarin FARKLI olmasidir; cografi dagilim
     *      anlasma yapilirken saglayici secimiyle saglanir.
     */
    uint32 public constant MIN_REPLICATION = 3;

    /// @notice Filecoin epoch suresi (saniye) — protokol sabiti.
    uint64 public constant EPOCH_SECONDS = 30;

    /**
     * @notice En kisa anlasma suresi: 180 gun (rapor WBS 2.3).
     * @dev 180 gun x 24 saat x 60 dk x 2 epoch/dk = 518.400 epoch.
     */
    uint64 public constant MIN_DEAL_EPOCHS = 518_400;

    /**
     * @notice Yenileme penceresi: bitise 30 gun kala yenileme gerekir.
     * @dev Anlasma bitene kadar beklemek gec olurdu — yeni anlasma yapmak,
     *      veriyi saglayiciya aktarmak ve sektorun muhurlenmesi zaman alir.
     */
    uint64 public constant RENEWAL_WINDOW_EPOCHS = 86_400;

    // ---------------------------------------------------------------------------------
    // Yapilandirma
    // ---------------------------------------------------------------------------------

    /**
     * @notice Filecoin genesis zaman damgasi (unix saniye).
     *
     * @dev Ana ag: 1.598.306.400 (24 Agustos 2020, 22:00 UTC). Calibration
     *      test aginin genesis'i farklidir; bu yuzden sabit degil `immutable`.
     *      Yanlis verilirse epoch hesabi kayar ve yenileme uyarilari yanlis
     *      zamanda cikar — dagitimda dogrulanmasi gereken bir degerdir.
     */
    uint64 public immutable filecoinGenesis;

    /// @notice Anlasmalari kaydeden tanik (zincir disi ajan).
    address public attestor;

    // ---------------------------------------------------------------------------------
    // Defter
    // ---------------------------------------------------------------------------------

    struct Deal {
        /// @dev Filecoin saglayici aktor numarasi (f0xxxx -> xxxx).
        uint64 providerId;
        /// @dev Filecoin market anlasma numarasi — herkese acik RPC ile dogrulanir.
        uint64 dealId;
        uint64 startEpoch;
        uint64 endEpoch;
        /// @dev Filecoin "piece CID" (commP) ozeti — anlasmanin neyi kapsadigi.
        bytes32 pieceCidDigest;
        /// @dev Saglayici sektoru dusurduyse / cezalandirildiysa true.
        bool terminated;
    }

    mapping(bytes32 cidDigest => Deal[]) private _deals;

    /// @notice Bu CID icin bu saglayicinin AKTIF bir anlasmasi var mi?
    mapping(bytes32 cidDigest => mapping(uint64 providerId => bool)) public providerStores;

    /// @notice Anlasma numarasi daha once kaydedildi mi (tekrar sayimi engeller)?
    mapping(uint64 dealId => bytes32 cidDigest) public dealToCid;

    /// @notice Kayitli en az bir anlasmasi olan CID sayisi — panel icin.
    uint256 public trackedCidCount;

    // ---------------------------------------------------------------------------------

    constructor(address initialOwner, uint64 filecoinGenesis_) Ownable(initialOwner) {
        filecoinGenesis = filecoinGenesis_;
    }

    modifier onlyAttestor() {
        if (msg.sender != attestor && msg.sender != owner()) revert NotAttestor(msg.sender);
        _;
    }

    function setAttestor(address attestor_) external onlyOwner {
        attestor = attestor_;
        emit AttestorUpdated(attestor_);
    }

    // ---------------------------------------------------------------------------------
    // 1) Epoch — oracle'siz
    // ---------------------------------------------------------------------------------

    /**
     * @notice Guncel Filecoin epoch'u.
     *
     * @dev Epoch suresi protokol sabiti oldugu icin bu deger tamamen
     *      aritmetiktir. Genesis'ten once bir zaman damgasi mumkun olmadigi
     *      icin (blok zamani gecmise gitmez) tasma kontrolu yapilmaz; yine de
     *      yanlis bir genesis verilirse sifir doner ve sorun sessiz kalmaz.
     */
    function currentEpoch() public view returns (uint64) {
        if (block.timestamp <= filecoinGenesis) return 0;
        return uint64((block.timestamp - filecoinGenesis) / EPOCH_SECONDS);
    }

    // ---------------------------------------------------------------------------------
    // 2) Anlasma kaydi
    // ---------------------------------------------------------------------------------

    /**
     * @notice Bir Filecoin depolama anlasmasini deftere isler.
     *
     * @dev  Zorlanan kurallar (hepsi rapor WBS 2.3'ten):
     *       - anlasma en az 180 gun surmeli,
     *       - ayni saglayici ayni CID icin iki kez sayilamaz — aksi halde
     *         tek bir madenciye 3 anlasma yapip "3 replika" gostermek mumkun
     *         olurdu ve cogaltmanin amaci (tek nokta hatasi) yok olurdu,
     *       - ayni `dealId` iki farkli CID'e baglanamaz.
     *
     * @param cidDigest      Sifreli blob'un IPFS CID ozeti (protokoldeki ile ayni).
     * @param providerId     Filecoin saglayici aktor numarasi.
     * @param dealId         Filecoin market anlasma numarasi.
     * @param startEpoch     Anlasmanin basladigi epoch.
     * @param endEpoch       Anlasmanin bittigi epoch.
     * @param pieceCidDigest Filecoin piece CID (commP) ozeti.
     */
    function registerDeal(
        bytes32 cidDigest,
        uint64 providerId,
        uint64 dealId,
        uint64 startEpoch,
        uint64 endEpoch,
        bytes32 pieceCidDigest
    ) external onlyAttestor {
        if (cidDigest == bytes32(0)) revert EmptyCid();
        if (endEpoch <= startEpoch) revert EndBeforeStart(startEpoch, endEpoch);
        if (dealToCid[dealId] != bytes32(0)) revert DealAlreadyRegistered(dealId);
        if (providerStores[cidDigest][providerId]) {
            revert ProviderAlreadyStores(cidDigest, providerId);
        }

        uint64 duration = endEpoch - startEpoch;
        if (duration < MIN_DEAL_EPOCHS) revert DealTooShort(duration, MIN_DEAL_EPOCHS);

        if (_deals[cidDigest].length == 0) trackedCidCount += 1;

        _deals[cidDigest].push(
            Deal({
                providerId: providerId,
                dealId: dealId,
                startEpoch: startEpoch,
                endEpoch: endEpoch,
                pieceCidDigest: pieceCidDigest,
                terminated: false
            })
        );

        providerStores[cidDigest][providerId] = true;
        dealToCid[dealId] = cidDigest;

        emit DealRegistered(cidDigest, dealId, providerId, startEpoch, endEpoch);

        uint32 active = activeReplicas(cidDigest);
        if (active >= MIN_REPLICATION) {
            emit ReplicationRestored(cidDigest, active);
        }
    }

    /**
     * @notice Bir anlasmanin dustugunu isler (saglayici cezalandirildi vb.).
     *
     * @dev Kayit SILINMEZ, isaretlenir. Silinseydi bir saglayicinin gecmiste
     *      basarisiz oldugu bilgisi kaybolur ve ayni saglayiciyla yeniden
     *      anlasma yapilip yapilmadigi izlenemezdi.
     *
     *      Saglayici kilidi acilir: dusen bir anlasmadan sonra ayni
     *      saglayiciyla YENI bir anlasma yapilabilmelidir.
     */
    function terminateDeal(uint64 dealId, string calldata reason) external onlyAttestor {
        bytes32 cidDigest = dealToCid[dealId];
        if (cidDigest == bytes32(0)) revert UnknownDeal(dealId);

        Deal[] storage deals = _deals[cidDigest];
        for (uint256 i = 0; i < deals.length; i++) {
            if (deals[i].dealId != dealId) continue;
            if (deals[i].terminated) revert DealAlreadyTerminated(dealId);

            deals[i].terminated = true;
            providerStores[cidDigest][deals[i].providerId] = false;

            emit DealTerminated(cidDigest, dealId, reason);

            uint32 active = activeReplicas(cidDigest);
            if (active < MIN_REPLICATION) {
                emit RenewalRequired(cidDigest, active, currentEpoch());
            }
            return;
        }
        revert UnknownDeal(dealId);
    }

    // ---------------------------------------------------------------------------------
    // 3) Kalicilik durumu
    // ---------------------------------------------------------------------------------

    /**
     * @notice Su an gecerli (dusmemis ve suresi dolmamis) anlasma sayisi.
     *
     * @dev Dongu O(anlasma sayisi). Bu sayi CID basina birkac tanedir
     *      (politika 3 ister); tum CID'ler uzerinde gezen bir dongu YOKTUR.
     */
    function activeReplicas(bytes32 cidDigest) public view returns (uint32 count) {
        uint64 epoch = currentEpoch();
        Deal[] storage deals = _deals[cidDigest];

        for (uint256 i = 0; i < deals.length; i++) {
            if (deals[i].terminated) continue;
            if (deals[i].endEpoch <= epoch) continue;
            count += 1;
        }
    }

    /// @notice Rapor WBS 2.3'teki 3 replika kurali saglaniyor mu?
    function isAdequatelyReplicated(bytes32 cidDigest) public view returns (bool) {
        return activeReplicas(cidDigest) >= MIN_REPLICATION;
    }

    /**
     * @notice Yenileme gerekiyor mu (WBS 2.3 "auto-renewal")?
     *
     * @dev Iki sebepten gerekir:
     *      1. aktif replika sayisi esigin altina dustu,
     *      2. anlasmalardan biri yenileme penceresine girdi.
     *
     *      Ikincisi olmasaydi yenileme ancak veri KAYBOLDUKTAN sonra
     *      tetiklenirdi; oysa yeni anlasma kurmak ve sektor muhurlemek
     *      zaman alir.
     */
    function renewalDue(bytes32 cidDigest) public view returns (bool) {
        if (_deals[cidDigest].length == 0) return false;
        if (activeReplicas(cidDigest) < MIN_REPLICATION) return true;

        uint64 epoch = currentEpoch();
        Deal[] storage deals = _deals[cidDigest];

        for (uint256 i = 0; i < deals.length; i++) {
            if (deals[i].terminated) continue;
            if (deals[i].endEpoch <= epoch) continue;
            if (deals[i].endEpoch - epoch <= RENEWAL_WINDOW_EPOCHS) return true;
        }
        return false;
    }

    /**
     * @notice Yenileme ihtiyacini OLAY olarak yayar; zincir disi ajan dinler.
     *
     * @dev Herkes cagirabilir: sart zaten zincirde gorunur bir olgudur ve
     *      yenilemenin baslatilmasi tek bir tarafin insafina birakilmamalidir.
     *      Cagri yalnizca gercekten gerekliyse olay yayar.
     */
    function flagRenewal(bytes32 cidDigest) external {
        if (!renewalDue(cidDigest)) return;
        emit RenewalRequired(cidDigest, activeReplicas(cidDigest), currentEpoch());
    }

    // ---------------------------------------------------------------------------------
    // 4) Okuma
    // ---------------------------------------------------------------------------------

    function dealCount(bytes32 cidDigest) external view returns (uint256) {
        return _deals[cidDigest].length;
    }

    function dealAt(bytes32 cidDigest, uint256 index) external view returns (Deal memory) {
        return _deals[cidDigest][index];
    }

    /// @notice Bir CID'in tum anlasmalari — dogrulama betigi bunu okur.
    function dealsOf(bytes32 cidDigest) external view returns (Deal[] memory) {
        return _deals[cidDigest];
    }

    /**
     * @notice Panelin tek cagriyla gosterebilecegi ozet.
     * @return replicas Aktif replika sayisi.
     * @return adequate 3 replika kurali saglaniyor mu?
     * @return dueForRenewal Yenileme gerekiyor mu?
     * @return earliestExpiryEpoch En erken biten aktif anlasmanin epoch'u (0 = yok).
     */
    function persistenceStatus(bytes32 cidDigest)
        external
        view
        returns (
            uint32 replicas,
            bool adequate,
            bool dueForRenewal,
            uint64 earliestExpiryEpoch
        )
    {
        replicas = activeReplicas(cidDigest);
        adequate = replicas >= MIN_REPLICATION;
        dueForRenewal = renewalDue(cidDigest);

        uint64 epoch = currentEpoch();
        Deal[] storage deals = _deals[cidDigest];
        for (uint256 i = 0; i < deals.length; i++) {
            if (deals[i].terminated) continue;
            if (deals[i].endEpoch <= epoch) continue;
            if (earliestExpiryEpoch == 0 || deals[i].endEpoch < earliestExpiryEpoch) {
                earliestExpiryEpoch = deals[i].endEpoch;
            }
        }
    }
}
