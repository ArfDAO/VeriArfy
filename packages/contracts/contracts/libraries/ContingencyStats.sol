// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, ebool, euint8, euint32} from "@fhevm/solidity/lib/FHE.sol";

/**
 * @title   ContingencyStats
 * @notice  Kategorik dozajlarin sifreli 2x3 KONTENJANS TABLOSUNU biriktirir.
 *
 * @dev  `BiomarkerStats`'in genomik ikizidir ve ayni sebeple ayri bir
 *       kutuphanedir: `VeriarfyProtocol` EIP-170'in 24.576 baytlik sinirini
 *       asti. `public` fonksiyonlar ayri bir adrese dagitilir ve
 *       `delegatecall` ile cagrilir; `address(this)` protokol olarak kaldigi
 *       icin fhEVM'in ACL kayitlari dogru kontrata yazilir.
 *
 *       IKI KATEGORI, IKI ISTATISTIK - ayrimin sebebi budur:
 *
 *         veri kategorisi 1 (genomik)     dozaj KATEGORIK (0/1/2)
 *                                         -> kontenjans tablosu -> ki-kare
 *         veri kategorisi 2 (biyobelirtec) olcum SUREKLI
 *                                         -> (n, Sum x, Sum x^2) -> Welch t
 *
 *       Ikisinde de zincirde yalnizca SAYIMLAR birikir; testin kendisi
 *       (ki-kare ya da t) bolme icerdigi icin duz metinde yapilir - sifreli
 *       bolme TFHE'de pratik degildir.
 */
library ContingencyStats {
    /// @dev Grup sayisi (kontrol / vaka).
    uint8 internal constant GROUP_COUNT = 2;

    /// @dev Dozaj seviyeleri: 0, 1, 2. Eksik (3) hicbirine uymaz.
    uint8 internal constant DOSAGE_LEVELS = 3;

    /**
     * @notice Bir SNP'nin 6 hucresini ilk kullanimda baslatir.
     *
     * @dev fhEVM'de baslatilmamis bir `euint32` sifir HANDLE'idir, sifir DEGER
     *      degil; uzerinde islem yapmak gecersizdir. Kurucuda tum paneli
     *      baslatmak binlerce SNP'de imkansiz oldugu icin baslatma ilk katkiya
     *      ertelenir. Maliyeti SNP basina bir kez odenir.
     */
    function initialize(mapping(uint32 => euint32[3][2]) storage table, uint32 snp) public {
        for (uint8 g = 0; g < GROUP_COUNT; ++g) {
            for (uint8 level = 0; level < DOSAGE_LEVELS; ++level) {
                euint32 zero = FHE.asEuint32(0);
                table[snp][g][level] = zero;
                FHE.allowThis(zero);
            }
        }
    }

    /**
     * @notice Tek bir dozaji tabloya homomorfik olarak isler.
     *
     * @dev  Her hucre icin "bu katilimci buraya mi ait" sorusu sifreliyken
     *       sorulur. `FHE.asEuint32(ebool)` sonucu 0 veya 1'e cevirir; dogru
     *       hucre 1 artar, digerleri 0 eklenerek DEGISMEDEN kalir.
     *
     *       Diger hucrelere de 0 eklenmesi israf degil ZORUNLULUKTUR: hangi
     *       hucrenin arttigi gizli kalmalidir. Kosullu yazim yapilsaydi islem
     *       izinden grup ve dozaj okunabilirdi.
     *
     * @param dosage Kirpilmis dozaj. 3 ("eksik") hicbir seviyeye uymaz,
     *        dolayisiyla katilimci o SNP'nin tablosuna hic girmez.
     * @param rareLevel Nadirlik biti icin aranan seviye.
     *
     * @return isRare `dozaj == rareLevel` biti. BEDAVA doner: o
     *         karsilastirma tablo icin zaten yapiliyor.
     */
    function accumulate(
        mapping(uint32 => euint32[3][2]) storage table,
        uint32 snp,
        euint8 dosage,
        ebool inControl,
        ebool inCase,
        uint8 rareLevel
    ) public returns (ebool isRare) {
        ebool[2] memory inGroup;
        inGroup[0] = inControl;
        inGroup[1] = inCase;

        for (uint8 level = 0; level < DOSAGE_LEVELS; ++level) {
            ebool atLevel = FHE.eq(dosage, level);

            if (level == rareLevel) {
                isRare = atLevel;
                FHE.allowThis(atLevel);
            }

            for (uint8 g = 0; g < GROUP_COUNT; ++g) {
                euint32 cell = FHE.add(
                    table[snp][g][level],
                    FHE.asEuint32(FHE.and(inGroup[g], atLevel))
                );
                table[snp][g][level] = cell;
                FHE.allowThis(cell);
            }
        }
    }

    /**
     * @notice Canli tabloyu bir acilim talebinin goruntusune kopyalar.
     *
     * @dev Kopyalanan handle'lar AYRI yasar; kontratin onlara erisimi de
     *      ayrica verilmelidir (`allowThis`).
     */
    function snapshot(
        mapping(uint32 => euint32[3][2]) storage live,
        mapping(uint32 => euint32[3][2]) storage frozen,
        uint32 snp
    ) public {
        for (uint8 g = 0; g < GROUP_COUNT; ++g) {
            for (uint8 level = 0; level < DOSAGE_LEVELS; ++level) {
                frozen[snp][g][level] = live[snp][g][level];
                FHE.allowThis(frozen[snp][g][level]);
            }
        }
    }

    /// @notice Dondurulmus tablonun cozum yetkisini arastirmaciya verir.
    function grant(
        mapping(uint32 => euint32[3][2]) storage frozen,
        uint32 snp,
        address researcher
    ) public {
        for (uint8 g = 0; g < GROUP_COUNT; ++g) {
            for (uint8 level = 0; level < DOSAGE_LEVELS; ++level) {
                FHE.allow(frozen[snp][g][level], researcher);
            }
        }
    }
}
