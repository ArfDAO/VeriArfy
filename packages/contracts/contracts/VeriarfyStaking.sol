// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {RarityMath} from "./libraries/RarityMath.sol";

interface IProtocolNodes {
    function isAuthorizedNode(address node) external view returns (bool);
    function authorizedNodeCount() external view returns (uint256);
    function disclosureApprovers(uint256 requestId) external view returns (address[] memory);
    function isDisclosureFinalized(uint256 requestId) external view returns (bool);
    function isDisclosureGranted(uint256 requestId) external view returns (bool);
    function isDisclosureRevoked(uint256 requestId) external view returns (bool);
    function challengeWindowEnd(uint256 requestId) external view returns (uint256);
    function revokeDisclosure(uint256 requestId) external;
    function revokeNode(address node) external;
}

interface IProtocolValue {
    /// @notice Sistemden bugune kadar gecen toplam ucret - "TotalDataValue".
    function cumulativeFees() external view returns (uint256);
}

/**
 * @title   VeriarfyStaking
 * @notice  Guvenilmez dugum riskine karsi kripto-ekonomik guvenlik - rapor 2.7.
 *
 * @dev
 * # Raporun tarifi
 *
 * Rapor 2.7.1 uc katmanli bir model tarif ediyor:
 *   1. ekonomik caydiricilik (staking / slashing),
 *   2. cogunluk onayi (2/3+ majority consensus),
 *   3. kriptografik dogrulama (threshold decryption).
 *
 * Ucuncusu zaten var (BSKK-44 + KMS imzalari). Bu sozlesme birinci ve
 * ikinciyi getiriyor.
 *
 * # RAPORDAN ONEMLI BIR SAPMA - durustce
 *
 * Rapor'un tehdit modeli "tembel hesaplama" (lazy computation): FHE
 * hesaplamasini yapan es-islemcinin isi atlayip rastgele sifreli metin
 * dondurmesi. Bu tehdit BIZIM sozlesmelerimizde YOKTUR ve bunu iddia etmek
 * yaniltici olurdu:
 *
 *   - Homomorfik hesabi Zama'nin es-islemci katmani yapar; onun dogrulugu
 *     Zama'nin kendi stake/konsensus katmaninda yasar, bizde degil.
 *   - Bizim zincirdeki her deger ya EVM'in kendi determinist hesabidir
 *     (itiraza konu olamaz) ya da KMS esik imzalariyla gelir ve zincirde
 *     dogrulanir (`IKMSVerifier`) - yani yanlis sonuc zaten kabul edilmez.
 *
 * Dolayisiyla Arbitrum tarzi **etkilesimli** (bisection) sahtekarlik kanitinin
 * burada tartisacagi bir hesap yoktur. Bunu taklit eden bir mekanizma yazmak,
 * calisiyormus gibi gorunen ama hicbir seyi ispatlamayan bir tiyatro olurdu.
 *
 * Bizim dugumlerimizin elindeki yetki farklidir ve daha tehlikelidir:
 * **cozum yetkisi vermek.** Kotu niyetli bir cogunluk, hak etmeyen bir
 * arastirmaciya havuzu actirabilir. Sozlesmenin kurallari bunu "gecersiz"
 * yapmaz - karar bir POLITIKA yargisidir, bir hesap degil.
 *
 * Politika yargisinin dogru denetim mekanizmasi da matematiksel kanit degil,
 * **akran denetimi + ekonomik risktir**. Uygulanan budur:
 *
 *   esik saglanir -> ITIRAZ SURESI -> itiraz yoksa yetki verilir
 *                                  -> itiraz varsa dugumler oylar
 *                                     kabul -> onaylayanlar kesilir + yasaklanir
 *                                     ret   -> itiraz edenin teminati kesilir
 *
 * # Neden itiraz suresi IZINDEN ONCE
 *
 * `FHE.allow` GERI ALINAMAZ. Izin verildikten sonra arastirmaci zincir
 * disinda aninda cozer; "itiraz kabul edildi" demek hicbir sey degistirmez.
 * Bu yuzden protokolde acilim iki adima ayrildi: `finalized` (esik saglandi)
 * ve `executed` (yetki fiilen verildi). Itiraz suresi ikisinin arasindadir.
 *
 * # Teminat neden yerli ETH
 *
 * Rapor "stake ettigi ETH/Token" diyor ve 32 ETH ornegi veriyor. Yerli ETH
 * secildi: onay (`approve`) adimi gerektirmez ve teminatin degeri odeme
 * token'inin kaderine baglanmaz.
 */
contract VeriarfyStaking is Ownable, ReentrancyGuard {
    // ---------------------------------------------------------------------------------
    // Hatalar
    // ---------------------------------------------------------------------------------

    error ZeroAddress();
    error NothingStaked(address node);
    error BelowMinimum(uint256 have, uint256 need);
    error NodeIsBanned(address node);
    error NotAuthorizedNode(address caller);
    error UnbondingActive(uint256 availableAtBlock);
    error NoUnbondingRequest(address node);
    error NothingToWithdraw();
    error RequestNotFinalized(uint256 requestId);
    error ChallengeWindowClosed(uint256 requestId, uint256 endedAtBlock);
    error AlreadyChallenged(uint256 requestId);
    error ApproverCannotChallenge(address node);
    error UnknownChallenge(uint256 challengeId);
    error ChallengeAlreadyResolved(uint256 challengeId);
    error VotingStillOpen(uint256 challengeId, uint256 endsAtBlock);
    error VotingClosed(uint256 challengeId);
    error AlreadyVoted(uint256 challengeId, address node);
    error ApproverCannotVote(address node);
    error WrongBond(uint256 sent, uint256 need);

    // ---------------------------------------------------------------------------------
    // Olaylar
    // ---------------------------------------------------------------------------------

    event Staked(address indexed node, uint256 amount, uint256 total);
    event UnbondingStarted(address indexed node, uint256 amount, uint256 availableAtBlock);
    event Withdrawn(address indexed node, uint256 amount);
    event Slashed(address indexed node, uint256 amount, string reason);
    event NodeBanned(address indexed node);
    event ChallengeOpened(
        uint256 indexed challengeId,
        uint256 indexed requestId,
        address indexed challenger,
        uint256 votingEndsAtBlock
    );
    event ChallengeVoted(uint256 indexed challengeId, address indexed node, bool uphold);
    event ChallengeResolved(uint256 indexed challengeId, bool upheld, uint256 slashedTotal);
    event ParametersUpdated(uint256 baseStake, uint256 valueThreshold);

    // ---------------------------------------------------------------------------------
    // Yapilandirma
    // ---------------------------------------------------------------------------------

    IProtocolNodes public immutable protocol;

    /// @notice Ucret hacmini (TotalDataValue) veren odeme sozlesmesi.
    IProtocolValue public payments;

    /**
     * @notice Taban teminat - rapor 2.7.1'de 32 ETH.
     *
     * @dev Yapilandirilabilir birakildi: test aglarinda 32 ETH edinmek mumkun
     *      degildir ve sabitlenseydi mekanizma hic denenemezdi. Uretim hedefi
     *      raporun verdigi degerdir.
     */
    uint256 public baseStake;

    /**
     * @notice Progresif teminat esigi - formuldeki `Threshold`.
     *
     * @dev  RAPORUN IKI VERISI BIRBIRIYLE TUTARSIZ; secim gerekcelendirildi.
     *
     *       Rapor 2.7.1: `MinStake = BaseStake x log2(TotalDataValue / Threshold)`
     *       ve iki kontrol noktasi veriyor (BaseStake = 32 ETH ile):
     *
     *         TotalDataValue > 1M USD   -> MinStake = 64 ETH  (carpan 2)
     *         TotalDataValue > 100M USD -> MinStake = 256 ETH (carpan 8)
     *
     *       Ikisi ayni `Threshold` ile saglanamaz:
     *         carpan 2 icin  -> Threshold = 250.000
     *         carpan 8 icin  -> Threshold = 390.625
     *
     *       250.000 secildi: 1M noktasini BIREBIR tutturur, 100M noktasinda
     *       276 ETH verir (rapor 256 diyor). Yani sapma DAHA YUKSEK teminat
     *       yonundedir - guvenlik acisindan dogru taraf. Tersi secim, raporun
     *       vaat ettiginden daha ucuz bir koalisyon saldirisi anlamina gelirdi.
     */
    uint256 public valueThreshold;

    /// @notice Teminat cekmek icin beklenmesi gereken blok sayisi (~1 gun).
    uint256 public constant UNBONDING_DELAY = 7_200;

    /// @notice Itiraz oylamasinin suresi (blok).
    uint256 public constant VOTING_PERIOD = 3_600;

    /**
     * @notice Itiraz icin yatirilan teminat - asilsiz itirazi pahali kilar.
     * @dev Taban teminatin onda biri. Sifir olsaydi her acilim bedava
     *      geciktirilebilirdi (hizmet engelleme).
     */
    function challengeBond() public view returns (uint256) {
        return baseStake / 10;
    }

    /**
     * @notice Itirazin kabulu icin gereken oy orani - rapor 2.7.1 "2/3+".
     * @dev Pay/payda olarak tutulur; ondalik yuvarlama tartismasi olmasin.
     */
    uint256 public constant UPHOLD_NUMERATOR = 2;
    uint256 public constant UPHOLD_DENOMINATOR = 3;

    // ---------------------------------------------------------------------------------
    // Durum
    // ---------------------------------------------------------------------------------

    /// @notice Dugumun kilitli teminati.
    mapping(address => uint256) public stakeOf;

    /// @notice Cekilmek uzere ayrilmis (artik teminat SAYILMAYAN) tutar.
    mapping(address => uint256) public unbonding;

    /// @notice Cekimin serbest kalacagi blok.
    mapping(address => uint256) public unbondingAvailableAt;

    /**
     * @notice Kalici men - rapor 2.7.1: "kalici olarak agdan men edilir".
     * @dev Geri alinamaz. Teminat yatirmak da yasakli dugumu geri getirmez.
     */
    mapping(address => bool) public isBanned;

    /// @notice Kesilen teminatlarin toplandigi havuz (yakilmaz, hazineye gider).
    uint256 public slashedPool;

    struct Challenge {
        uint256 requestId;
        address challenger;
        uint256 bond;
        uint256 votingEndsAtBlock;
        uint32 upholdVotes;
        uint32 rejectVotes;
        bool resolved;
    }

    mapping(uint256 => Challenge) private _challenges;
    mapping(uint256 challengeId => mapping(address => bool)) public hasVoted;
    /// @notice Bir acilim talebine acilmis itirazin kimligi (+1; 0 = yok).
    mapping(uint256 requestId => uint256) private _challengeOfRequest;

    uint256 public nextChallengeId;

    // ---------------------------------------------------------------------------------

    constructor(
        address initialOwner,
        address protocol_,
        uint256 baseStake_,
        uint256 valueThreshold_
    ) Ownable(initialOwner) {
        if (protocol_ == address(0)) revert ZeroAddress();
        protocol = IProtocolNodes(protocol_);
        baseStake = baseStake_;
        valueThreshold = valueThreshold_;
    }

    /// @notice Ucret hacmini okuyacak odeme sozlesmesini baglar.
    function setPayments(address payments_) external onlyOwner {
        payments = IProtocolValue(payments_);
    }

    function setParameters(uint256 baseStake_, uint256 valueThreshold_) external onlyOwner {
        baseStake = baseStake_;
        valueThreshold = valueThreshold_;
        emit ParametersUpdated(baseStake_, valueThreshold_);
    }

    // ---------------------------------------------------------------------------------
    // 1) Progresif teminat - rapor 2.7.1
    // ---------------------------------------------------------------------------------

    /**
     * @notice Su anda gereken en az teminat.
     *
     * @dev `MinStake = BaseStake x log2(TotalDataValue / Threshold)`
     *
     *      Esigin ALTINDA taban teminat uygulanir. Formul oldugu gibi
     *      uygulansaydi `log2(x<1)` negatif olur, sistemin en kirilgan
     *      oldugu ilk gunlerde teminati SIFIRA indirirdi - raporun amaciyla
     *      taban tabana zit bir sonuc.
     *
     *      Ayni sekilde oran tam 2'nin altindayken carpan 1'in altina duser;
     *      taban teminat alt sinir olarak korunur.
     */
    function minStake() public view returns (uint256) {
        if (address(payments) == address(0) || valueThreshold == 0) return baseStake;

        uint256 totalValue = payments.cumulativeFees();
        if (totalValue <= valueThreshold) return baseStake;

        // `multiplierBps(N, C)` = log2(1 + N/C) - formulde "1 +" yoktur.
        // Orani dogrudan kurup log2'sini almak icin `1 + (x-1)/1` kimligi
        // kullanilir: multiplierBps(x - 1, 1) = log2(x).
        uint256 ratio = totalValue / valueThreshold;

        // `multiplierBps` uint32 alir. Oran bunu asarsa log2 zaten 32'yi gecmis
        // demektir; taban teminatin 32 katindan sonra formulun buyume hizi
        // anlamsizlasir. Kirpma, tasip KUCUK bir teminat uretmekten iyidir.
        if (ratio - 1 > type(uint32).max) ratio = uint256(type(uint32).max) + 1;

        uint256 multiplierBps = RarityMath.multiplierBps(uint32(ratio - 1), 1);

        uint256 required = (baseStake * multiplierBps) / RarityMath.ONE_BPS;
        return required < baseStake ? baseStake : required;
    }

    /// @notice Dugum oy kullanabilir mi? Protokol bunu sorar.
    function canApprove(address node) external view returns (bool) {
        if (isBanned[node]) return false;
        return stakeOf[node] >= minStake();
    }

    // ---------------------------------------------------------------------------------
    // 2) Teminat yatirma / cekme
    // ---------------------------------------------------------------------------------

    /// @notice Teminat yatirir. Yasakli dugum yatiramaz.
    function stake() external payable nonReentrant {
        if (isBanned[msg.sender]) revert NodeIsBanned(msg.sender);
        if (msg.value == 0) revert NothingStaked(msg.sender);

        stakeOf[msg.sender] += msg.value;
        emit Staked(msg.sender, msg.value, stakeOf[msg.sender]);
    }

    /**
     * @notice Teminatin bir kismini cekim kuyruguna alir.
     *
     * @dev  KUYRUGA ALINAN TUTAR ANINDA TEMINAT OLMAKTAN CIKAR.
     *
     *       Aksi halde bir dugum, kotu bir onay verdikten hemen sonra cekim
     *       baslatip itiraz suresi boyunca teminatli gorunur, sure biter
     *       bitmez parasini alirdi. `UNBONDING_DELAY`, itiraz + oylama
     *       suresinden uzun olmalidir; oyle secildi (7.200 > 3.600).
     */
    function requestUnstake(uint256 amount) external nonReentrant {
        uint256 balance = stakeOf[msg.sender];
        if (amount == 0 || amount > balance) revert NothingStaked(msg.sender);

        stakeOf[msg.sender] = balance - amount;
        unbonding[msg.sender] += amount;
        unbondingAvailableAt[msg.sender] = block.number + UNBONDING_DELAY;

        emit UnbondingStarted(msg.sender, amount, unbondingAvailableAt[msg.sender]);
    }

    /// @notice Bekleme suresi dolan teminati cekar.
    function withdraw() external nonReentrant {
        uint256 amount = unbonding[msg.sender];
        if (amount == 0) revert NoUnbondingRequest(msg.sender);

        uint256 availableAt = unbondingAvailableAt[msg.sender];
        if (block.number < availableAt) revert UnbondingActive(availableAt);

        unbonding[msg.sender] = 0;
        unbondingAvailableAt[msg.sender] = 0;

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert NothingToWithdraw();

        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------------------------
    // 3) Itiraz - rapor 2.7.1
    // ---------------------------------------------------------------------------------

    /**
     * @notice Esige ulasmis bir acilima itiraz eder.
     *
     * @dev  Kimler itiraz edebilir: teminatli, YASAKLI OLMAYAN ve o talebi
     *       ONAYLAMAMIS yetkili dugumler. Onaylayanin itiraz etmesi anlamsizdir
     *       ve oylamayi kirletirdi.
     *
     *       Itiraz suresi ICINDE yapilmalidir; sure dolduysa acilim zaten
     *       verilebilir durumdadir ve geri alinamaz.
     *
     * @param requestId Protokoldeki acilim talebinin kimligi.
     */
    function challenge(uint256 requestId) external payable nonReentrant returns (uint256 id) {
        if (!protocol.isAuthorizedNode(msg.sender)) revert NotAuthorizedNode(msg.sender);
        if (isBanned[msg.sender]) revert NodeIsBanned(msg.sender);
        if (stakeOf[msg.sender] < minStake()) {
            revert BelowMinimum(stakeOf[msg.sender], minStake());
        }
        if (msg.value != challengeBond()) revert WrongBond(msg.value, challengeBond());

        if (!protocol.isDisclosureFinalized(requestId)) revert RequestNotFinalized(requestId);
        if (_challengeOfRequest[requestId] != 0) revert AlreadyChallenged(requestId);

        uint256 windowEnd = protocol.challengeWindowEnd(requestId);
        if (block.number >= windowEnd) revert ChallengeWindowClosed(requestId, windowEnd);

        if (_isApprover(requestId, msg.sender)) revert ApproverCannotChallenge(msg.sender);

        id = nextChallengeId++;
        _challenges[id] = Challenge({
            requestId: requestId,
            challenger: msg.sender,
            bond: msg.value,
            votingEndsAtBlock: block.number + VOTING_PERIOD,
            upholdVotes: 0,
            rejectVotes: 0,
            resolved: false
        });
        _challengeOfRequest[requestId] = id + 1; // +1: 0 "yok" demek

        // Acilim, itiraz cozulene kadar FIILEN verilemez. Protokolde iptal
        // bayragini simdiden kaldirmiyoruz - itiraz reddedilirse acilim
        // devam etmelidir. Engelleme, `resolveChallenge` gelene kadar
        // `executeDisclosure`'in penceresini asmasiyla degil, asagidaki
        // `isBlocked` kontrolu ile saglanir.
        emit ChallengeOpened(id, requestId, msg.sender, _challenges[id].votingEndsAtBlock);
    }

    /**
     * @notice Itiraz hakkinda oy verir - rapor 2.7.1 "2/3+ majority consensus".
     *
     * @dev Talebi onaylayanlar oy KULLANAMAZ: kendi kararlarini yargilamak
     *      denetimi anlamsiz kilardi. Itiraz eden de oy kullanmaz; itirazi
     *      zaten onun iddiasidir.
     */
    function voteOnChallenge(uint256 challengeId, bool uphold) external nonReentrant {
        Challenge storage c = _challenges[challengeId];
        if (c.challenger == address(0)) revert UnknownChallenge(challengeId);
        if (c.resolved) revert ChallengeAlreadyResolved(challengeId);
        if (block.number >= c.votingEndsAtBlock) revert VotingClosed(challengeId);

        if (!protocol.isAuthorizedNode(msg.sender)) revert NotAuthorizedNode(msg.sender);
        if (isBanned[msg.sender]) revert NodeIsBanned(msg.sender);
        if (stakeOf[msg.sender] < minStake()) {
            revert BelowMinimum(stakeOf[msg.sender], minStake());
        }
        if (hasVoted[challengeId][msg.sender]) revert AlreadyVoted(challengeId, msg.sender);
        if (_isApprover(c.requestId, msg.sender)) revert ApproverCannotVote(msg.sender);

        hasVoted[challengeId][msg.sender] = true;
        if (uphold) c.upholdVotes += 1;
        else c.rejectVotes += 1;

        emit ChallengeVoted(challengeId, msg.sender, uphold);
    }

    /**
     * @notice Oylamayi kapatir ve sonucu uygular.
     *
     * @dev  KABUL ESIGI: kullanilan oylarin 2/3'u (rapor 2.7.1).
     *
     *       Payda neden KULLANILAN oy, tum dugumler degil: cekimser bir
     *       cogunluk her itirazi otomatik reddederdi. Denetimin islemesi icin
     *       sessizligin "hayir" sayilmamasi gerekir. Buna karsilik hic oy
     *       kullanilmamissa itiraz REDDEDILIR - kimsenin desteklemedigi bir
     *       iddia dugum kesmeye yetmez.
     *
     *       Kabul -> talebi onaylayan HER dugumun teminati kesilir ve dugum
     *       kalici olarak men edilir; acilim iptal edilir.
     *       Ret   -> itiraz edenin teminati kesilir (asilsiz itiraz bedava
     *       olmamalidir).
     */
    function resolveChallenge(uint256 challengeId) external nonReentrant {
        Challenge storage c = _challenges[challengeId];
        if (c.challenger == address(0)) revert UnknownChallenge(challengeId);
        if (c.resolved) revert ChallengeAlreadyResolved(challengeId);
        if (block.number < c.votingEndsAtBlock) {
            revert VotingStillOpen(challengeId, c.votingEndsAtBlock);
        }

        c.resolved = true;

        uint256 cast = uint256(c.upholdVotes) + uint256(c.rejectVotes);
        bool upheld = cast > 0 &&
            uint256(c.upholdVotes) * UPHOLD_DENOMINATOR >= cast * UPHOLD_NUMERATOR;

        uint256 slashedTotal;

        if (upheld) {
            // Acilim iptal edilir - henuz verilmemis olmasi gerekir. Itiraz
            // suresi + oylama suresi boyunca `executeDisclosure` engellendigi
            // icin bu garanti altindadir.
            protocol.revokeDisclosure(c.requestId);

            address[] memory approvers = protocol.disclosureApprovers(c.requestId);
            for (uint256 i = 0; i < approvers.length; i++) {
                slashedTotal += _slash(approvers[i], "kabul edilen itiraz");
            }

            // Itiraz eden teminatini geri alir.
            (bool ok, ) = c.challenger.call{value: c.bond}("");
            if (!ok) revert NothingToWithdraw();
        } else {
            // Asilsiz itiraz: teminat kesilir.
            slashedPool += c.bond;
            slashedTotal = c.bond;
            emit Slashed(c.challenger, c.bond, "reddedilen itiraz");
        }

        emit ChallengeResolved(challengeId, upheld, slashedTotal);
    }

    /**
     * @notice Bir acilim, cozulmemis bir itiraz yuzunden bekliyor mu?
     *
     * @dev Protokolun `executeDisclosure`'i bunu dogrudan sormaz; onun yerine
     *      itiraz kabul edilirse `revokeDisclosure` cagrilir. Bu gorunum,
     *      arayuzun "neden hala verilmedi" sorusunu yanitlamasi icindir.
     */
    function isBlocked(uint256 requestId) external view returns (bool) {
        uint256 slot = _challengeOfRequest[requestId];
        if (slot == 0) return false;
        return !_challenges[slot - 1].resolved;
    }

    function challengeOf(uint256 requestId)
        external
        view
        returns (bool exists, uint256 challengeId)
    {
        uint256 slot = _challengeOfRequest[requestId];
        return (slot != 0, slot == 0 ? 0 : slot - 1);
    }

    function challengeInfo(uint256 challengeId)
        external
        view
        returns (
            uint256 requestId,
            address challenger,
            uint256 bond,
            uint256 votingEndsAtBlock,
            uint32 upholdVotes,
            uint32 rejectVotes,
            bool resolved
        )
    {
        Challenge storage c = _challenges[challengeId];
        if (c.challenger == address(0)) revert UnknownChallenge(challengeId);
        return (
            c.requestId,
            c.challenger,
            c.bond,
            c.votingEndsAtBlock,
            c.upholdVotes,
            c.rejectVotes,
            c.resolved
        );
    }

    // ---------------------------------------------------------------------------------
    // 4) Kesme ve hazine
    // ---------------------------------------------------------------------------------

    /**
     * @dev Teminatin TAMAMI kesilir ve dugum kalici men edilir (rapor 2.7.1:
     *      "aninda yakilir" + "kalici olarak agdan men edilir").
     *
     *      Kesilen tutar YAKILMAZ, hazine havuzunda toplanir. Yakmak yerine
     *      toplamak bilincli: zarar goren taraf katilimcilardir ve tazminatin
     *      kaynagi olmasi, degeri yok etmekten daha anlamlidir.
     *
     *      Cekim kuyrugundaki tutar da kesilir; aksi halde kotu onay verip
     *      hemen cekim baslatmak cezadan kacmanin yolu olurdu.
     */
    function _slash(address node, string memory reason) private returns (uint256 amount) {
        amount = stakeOf[node] + unbonding[node];

        stakeOf[node] = 0;
        unbonding[node] = 0;
        unbondingAvailableAt[node] = 0;
        slashedPool += amount;

        if (!isBanned[node]) {
            isBanned[node] = true;
            emit NodeBanned(node);
        }

        // Yasakli dugum onay veremez; yetkisi de protokolden dusurulur.
        if (protocol.isAuthorizedNode(node)) {
            protocol.revokeNode(node);
        }

        emit Slashed(node, amount, reason);
    }

    /// @notice Kesilen teminatlari hazineye aktarir.
    function withdrawSlashed(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = slashedPool;
        if (amount == 0) revert NothingToWithdraw();

        slashedPool = 0;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert NothingToWithdraw();
    }

    function _isApprover(uint256 requestId, address node) private view returns (bool) {
        address[] memory approvers = protocol.disclosureApprovers(requestId);
        for (uint256 i = 0; i < approvers.length; i++) {
            if (approvers[i] == node) return true;
        }
        return false;
    }
}
