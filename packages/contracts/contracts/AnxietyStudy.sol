// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, euint8, euint32, ebool, externalEuint8, externalEuint32} from "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

import {IVeriArfyRegistry} from "./interfaces/IVeriArfyRegistry.sol";

/**
 * @title   AnxietyStudy
 * @notice  "Sosyal medya kullanimi ↔ anksiyete / panik" calismasinin FHE hatti.
 *
 * @dev  CALISMA SORUSU
 *       Gunluk sosyal medya kullanimi DUSUK (0–5s) olanlar ile YUKSEK (10+s)
 *       olanlar arasinda anksiyete ve panik siddeti farkli mi?
 *
 *       NEDEN BU TASARIM
 *       Bir grubun tum istatistigi uc tamsayidan turetilebilir:
 *           n, Σx, Σx²   ->   ortalama = Σx/n,  varyans = (n·Σx² − (Σx)²)/(n·(n−1))
 *       Bu yuzden kontrat bireysel puani HIC ACMADAN yalnizca bu uc toplami
 *       homomorfik olarak biriktirir. Bireysel yanit zincire duz olarak hic
 *       yazilmaz, saklanmaz ve hicbir adres icin cozulebilir yapilmaz.
 *
 *       KATILIMCININ GRUBU DA GIZLIDIR
 *       Kullanim grubu bile sifreli gelir. Kontrat her grup icin
 *       `eq(group, g)` ile sifreli bir bayrak uretir ve katkiyi
 *       `select(bayrak, deger, 0)` ile yalnizca dogru gruba ekler.
 *       Boylece "bu kisi gunde 10+ saat kullaniyor" bilgisi de sizmaz.
 *
 *       BUTUNLUK
 *       Puanlar homomorfik olarak `min` ile ust sinira kirpilir; boylece
 *       kotu niyetli bir katilimci sisirilmis bir degerle toplamlari bozamaz.
 *
 *       NE ACILIR
 *       Yalnizca grup duzeyindeki 3 × (n, Σx, Σx²) toplamlari herkese acik
 *       cozulebilir yapilir. Yayimlanan sonuc budur.
 */
contract AnxietyStudy is SepoliaConfig {
    /// @notice Kullanim gruplari: 0 = 0–5 saat, 1 = 5–10 saat, 2 = 10+ saat.
    uint8 public constant GROUP_COUNT = 3;

    /// @notice Burns Anxiety Inventory: 33 madde × 0–3 = 0–99.
    uint32 public constant ANXIETY_MAX = 99;

    /// @notice PDSS yapisinda panik olcegi: 7 madde × 0–4 = 0–28.
    uint32 public constant PANIC_MAX = 28;

    /// @dev Grup basina sifreli toplamlar.
    struct Accumulator {
        euint32 n;
        euint32 sum;
        euint32 sumSq;
    }

    IVeriArfyRegistry public immutable registry;
    address public owner;

    Accumulator[GROUP_COUNT] private _anxiety;
    Accumulator[GROUP_COUNT] private _panic;

    /// @notice Toplam katilimci (grup dagilimi sifreli kalir).
    uint32 public participantCount;

    /// @notice Bir adres calismaya yalnizca bir kez katilabilir.
    mapping(address account => bool submitted) public hasSubmitted;

    event ResponseSubmitted(address indexed participant, uint32 participantIndex);
    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);

    error NotRegistered(address account);
    error AlreadySubmitted(address account);
    error NotOwner();
    error ZeroAddress();

    constructor(address registryAddress) {
        if (registryAddress == address(0)) revert ZeroAddress();
        registry = IVeriArfyRegistry(registryAddress);
        owner = msg.sender;

        // Toplamlari sifirdan baslat ve kalici erisim izinlerini kur.
        for (uint8 g = 0; g < GROUP_COUNT; g++) {
            _initAccumulator(_anxiety[g]);
            _initAccumulator(_panic[g]);
        }
    }

    function _initAccumulator(Accumulator storage acc) internal {
        acc.n = FHE.asEuint32(0);
        acc.sum = FHE.asEuint32(0);
        acc.sumSq = FHE.asEuint32(0);
        _publish(acc);
    }

    /// @dev Toplamlar hem kontrat tarafindan tekrar kullanilabilir hem de
    ///      herkese acik cozulebilir olmali — yayimlanan sonuc bunlar.
    function _publish(Accumulator storage acc) internal {
        FHE.allowThis(acc.n);
        FHE.allowThis(acc.sum);
        FHE.allowThis(acc.sumSq);
        FHE.makePubliclyDecryptable(acc.n);
        FHE.makePubliclyDecryptable(acc.sum);
        FHE.makePubliclyDecryptable(acc.sumSq);
    }

    /**
     * @notice Sifreli anket yanitini gonderir.
     * @param  encGroup    Sifreli kullanim grubu (0,1,2).
     * @param  encAnxiety  Sifreli Burns anksiyete toplami (0–99).
     * @param  encPanic    Sifreli panik toplami (0–28).
     * @param  inputProof  Uc girdinin ortak relayer ispati.
     *
     * @dev Tum girdiler tek bir sifreli girdi paketinde uretilir
     *      (`createEncryptedInput().add8().add32().add32().encrypt()`).
     */
    function submit(
        externalEuint8 encGroup,
        externalEuint32 encAnxiety,
        externalEuint32 encPanic,
        bytes calldata inputProof
    ) external {
        if (!registry.isRegistered(msg.sender)) revert NotRegistered(msg.sender);
        if (hasSubmitted[msg.sender]) revert AlreadySubmitted(msg.sender);

        euint8 group = FHE.fromExternal(encGroup, inputProof);
        euint32 anxiety = FHE.fromExternal(encAnxiety, inputProof);
        euint32 panic = FHE.fromExternal(encPanic, inputProof);

        // Butunluk: gecerli araligin disina tasan puanlari homomorfik kirp.
        anxiety = FHE.min(anxiety, FHE.asEuint32(ANXIETY_MAX));
        panic = FHE.min(panic, FHE.asEuint32(PANIC_MAX));

        // Kareler kontratta hesaplanir — katilimci yanlis kare gonderemez.
        euint32 anxietySq = FHE.mul(anxiety, anxiety);
        euint32 panicSq = FHE.mul(panic, panic);

        euint32 zero = FHE.asEuint32(0);
        euint32 one = FHE.asEuint32(1);

        for (uint8 g = 0; g < GROUP_COUNT; g++) {
            // Sifreli grup bayragi: katilimci bu gruptaysa 1, degilse 0.
            ebool inGroup = FHE.eq(group, g);

            _accumulate(_anxiety[g], inGroup, one, anxiety, anxietySq, zero);
            _accumulate(_panic[g], inGroup, one, panic, panicSq, zero);
        }

        hasSubmitted[msg.sender] = true;
        uint32 index = participantCount++;

        emit ResponseSubmitted(msg.sender, index);
    }

    /// @dev Katkiyi yalnizca dogru gruba ekler; digerlerine 0 ekler.
    function _accumulate(
        Accumulator storage acc,
        ebool inGroup,
        euint32 one,
        euint32 value,
        euint32 valueSq,
        euint32 zero
    ) internal {
        acc.n = FHE.add(acc.n, FHE.select(inGroup, one, zero));
        acc.sum = FHE.add(acc.sum, FHE.select(inGroup, value, zero));
        acc.sumSq = FHE.add(acc.sumSq, FHE.select(inGroup, valueSq, zero));
        _publish(acc);
    }

    // --- Sonuc okuma ---------------------------------------------------------

    /**
     * @notice Bir grubun anksiyete toplamlarinin sifreli handle'lari.
     * @dev Herkese acik cozulebilir; istemci `publicDecrypt` ile duz degeri alir.
     */
    function anxietyAggregate(uint8 group)
        external
        view
        returns (euint32 n, euint32 sum, euint32 sumSq)
    {
        Accumulator storage acc = _anxiety[group];
        return (acc.n, acc.sum, acc.sumSq);
    }

    /// @notice Bir grubun panik toplamlarinin sifreli handle'lari.
    function panicAggregate(uint8 group)
        external
        view
        returns (euint32 n, euint32 sum, euint32 sumSq)
    {
        Accumulator storage acc = _panic[group];
        return (acc.n, acc.sum, acc.sumSq);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }
}
