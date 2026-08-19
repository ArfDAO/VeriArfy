// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, ebool, euint32, euint64} from "@fhevm/solidity/lib/FHE.sol";

/**
 * @title   BiomarkerStats
 * @notice  Surekli olcumlerin sifreli YETERLI ISTATISTIKLERINI biriktirir.
 *
 * @dev  NEDEN AYRI BIR KUTUPHANE — KOD BOYUTU
 *
 *       `VeriarfyProtocol` EIP-170 sinirina (24.576 bayt) dayandi: metrik
 *       kanali eklendiginde derlenmis boyut 27.807 bayta cikti, yani kontrat
 *       DAGITILAMAZ hale geldi. Optimizasyon ayarlari yetmedi — `runs: 1` ile
 *       bile 26.507 bayt, `viaIR` ile 28.483 bayt (daha kotu).
 *
 *       Cozum yapisal olmak zorundaydi: bu kutuphanenin fonksiyonlari
 *       `public`'tir, yani ayri bir adrese dagitilir ve kontrattan
 *       `delegatecall` ile cagrilir. Kod protokolun disinda yasar ama
 *       `address(this)` protokol olarak kalir — fhEVM'in ACL kayitlari
 *       dogru kontrata yazilir. `internal` yapilsaydi kod satir ici gomulur
 *       ve hicbir sey kazanilmazdi.
 *
 *       MALIYET: metrik basina bir `delegatecall` (~2.600 gaz). Ayni metrigin
 *       homomorfik islemleri 1,9 milyon HCU ve yuz binlerce gaz tuttugu icin
 *       bu fark olculebilir bile degil.
 *
 *       NEDEN BU UC SAYI: Welch t-testi icin grup basina yalnizca n, Sum x ve
 *       Sum x^2 gerekir; birey duzeyinde hicbir sey saklanmaz. Testin kendisi
 *       duz metinde yapilir (`packages/study` -> `compareGroups`) cunku
 *       varyans formulu BOLME icerir ve sifreli bolme TFHE'de pratik degildir.
 */
library BiomarkerStats {
    /// @notice Bir metrigin bir gruptaki sifreli yeterli istatistikleri.
    struct Accumulator {
        euint64 sum;
        euint64 sumSq;
        euint32 count;
    }

    /// @dev Grup sayisi (kontrol / vaka) — protokoldeki `GROUP_COUNT` ile ayni.
    uint8 internal constant GROUP_COUNT = 2;

    /**
     * @notice Metrigin akumulatorlerini sifirli sifreli degerlerle baslatir.
     *
     * @dev fhEVM'de "henuz yazilmamis" bir handle kullanilamaz; toplama
     *      yapilabilmesi icin once onemsiz (trivial) sifreli sifir yazilmalidir.
     */
    function initialize(mapping(uint32 => Accumulator[2]) storage table, uint32 metric) public {
        euint64 zero64 = FHE.asEuint64(0);
        euint32 zero32 = FHE.asEuint32(0);

        for (uint8 g = 0; g < GROUP_COUNT; ++g) {
            Accumulator storage acc = table[metric][g];
            acc.sum = zero64;
            acc.sumSq = zero64;
            acc.count = zero32;
            FHE.allowThis(acc.sum);
            FHE.allowThis(acc.sumSq);
            FHE.allowThis(acc.count);
        }
    }

    /**
     * @notice Tek bir olcumu iki grubun toplamlarina homomorfik olarak isler.
     *
     * @dev  ARALIK DISI = EKSIK, KIRPMA DEGIL
     *
     *       MK-0013'te genomik tarafta ogrenilen kural burada da gecerlidir:
     *       arali disi bir degeri sinira KIRPMAK, uydurma ama gecerli gorunen
     *       bir gozlem uretir. 200 ml/kg/dk gonderen bir istemci 90'a
     *       kirpilsaydi "olaganustu sporcu" olarak ortalamayi yukari cekerdi.
     *       Elenmek dogru davranistir: olcum yok sayilir, katilimci o metrigin
     *       `n` sayimina hic girmez.
     *
     *       Ayni tek kural EKSIK veriyi de halleder: olculmemis metrik 0
     *       gonderilir ve `minValue >= 1` zorunlu oldugu icin 0 zaten arali
     *       disidir. Ayri bir "var/yok" bayragi gondermeye gerek kalmaz —
     *       bir sifreli girdi ve bir karsilastirma tasarruf edilir.
     *
     *       ONCE MASKELE, SONRA KARESINI AL: sirasi bedava bir tasarruftur.
     *       Maskelenmis deger elenen olcumde 0'dir, karesi de 0 olur. Once
     *       kare alinsaydi karenin de ayrica maskelenmesi gerekirdi (bir
     *       `select` daha, ~55.000 HCU).
     *
     *       HANGI GRUBA YAZILDIGI GIZLI KALIR: diger gruba da 0 eklenir.
     *       Kosullu yazim yapilsaydi islem izinden katilimcinin grubu
     *       okunabilirdi.
     *
     * @param raw      Istemcide sifrelenmis OLCEKLI olcum.
     * @param minValue Gecerli olcekli alt sinir (dahil); en az 1.
     * @param maxValue Gecerli olcekli ust sinir (dahil).
     * @param inControl Katilimci kontrol grubunda mi (sifreli)?
     * @param inCase    Katilimci vaka grubunda mi (sifreli)?
     */
    function accumulate(
        mapping(uint32 => Accumulator[2]) storage table,
        uint32 metric,
        euint32 raw,
        uint32 minValue,
        uint32 maxValue,
        ebool inControl,
        ebool inCase
    ) public {
        ebool use = FHE.and(FHE.ge(raw, minValue), FHE.le(raw, maxValue));

        euint64 zero64 = FHE.asEuint64(0);
        euint64 value = FHE.select(use, FHE.asEuint64(raw), zero64);
        euint64 square = FHE.mul(value, value);

        ebool[2] memory inGroup;
        inGroup[0] = inControl;
        inGroup[1] = inCase;

        for (uint8 g = 0; g < GROUP_COUNT; ++g) {
            ebool take = FHE.and(inGroup[g], use);
            Accumulator storage acc = table[metric][g];

            acc.sum = FHE.add(acc.sum, FHE.select(take, value, zero64));
            acc.sumSq = FHE.add(acc.sumSq, FHE.select(take, square, zero64));
            acc.count = FHE.add(acc.count, FHE.asEuint32(take));

            FHE.allowThis(acc.sum);
            FHE.allowThis(acc.sumSq);
            FHE.allowThis(acc.count);
        }
    }

    /**
     * @notice Canli toplamlari bir acilim talebinin goruntusune kopyalar.
     *
     * @dev Kopyalanan handle'lar AYRI yasar; kontratin onlara erisimi de
     *      ayrica verilmelidir (`allowThis`).
     */
    function snapshot(
        mapping(uint32 => Accumulator[2]) storage live,
        mapping(uint32 => Accumulator[2]) storage frozen,
        uint32 metric
    ) public {
        for (uint8 g = 0; g < GROUP_COUNT; ++g) {
            Accumulator storage from = live[metric][g];
            Accumulator storage to = frozen[metric][g];

            to.sum = from.sum;
            to.sumSq = from.sumSq;
            to.count = from.count;

            FHE.allowThis(to.sum);
            FHE.allowThis(to.sumSq);
            FHE.allowThis(to.count);
        }
    }

    /// @notice Dondurulmus toplamlarin cozum yetkisini arastirmaciya verir.
    function grant(
        mapping(uint32 => Accumulator[2]) storage frozen,
        uint32 metric,
        address researcher
    ) public {
        for (uint8 g = 0; g < GROUP_COUNT; ++g) {
            Accumulator storage acc = frozen[metric][g];
            FHE.allow(acc.sum, researcher);
            FHE.allow(acc.sumSq, researcher);
            FHE.allow(acc.count, researcher);
        }
    }
}
