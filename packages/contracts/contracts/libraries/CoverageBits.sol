// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

/**
 * @title   CoverageBits
 * @notice  Kimin HANGI ALANDA gercek verisi oldugunu tutar - acik, sifresiz.
 *
 * @dev  NEDEN ACIK
 *
 *       Odeme, kullanilan alana gore dagitilir: bir arastirmaci
 *       {rs4977574, VO2MAX} isterse, o alanlara gercekten veri vermis olanlar
 *       pay alir. Bunu hesaplayabilmek icin kapsama duz metin olmak
 *       ZORUNDADIR - sifreli bir bitmap'ten pay dagitilamaz.
 *
 *       SIZAN SEY DEGER DEGIL, VARLIK. "Bu adresin rs4977574 olcumu var"
 *       bilgisi aciga cikar; dozajin 0 mi 1 mi 2 mi oldugu cikmaz. Genomikte
 *       kapsama buyuk olcude hangi cipin kullanildigini soyler, biyolojiyi
 *       degil.
 *
 *       KULLANICI BEYAN ETMEZ, SISTEM CIKARIR
 *
 *       Siradan bir kullanici dosyasinin icinde hangi varyantlarin
 *       oldugunu bilmez - doktor degildir, dosyanin TURUNU bilir. Bu yuzden
 *       bitmap istemcideki ayristiricidan gelir (`alignToPanel` zaten hangi
 *       alanin bulundugunu doner), kullaniciya sorulmaz.
 *
 *       GUVEN SINIRI - ACIKCA
 *
 *       Sozlesme bitmap'in sifreli veriyle ORTUSTUGUNU dogrulayamaz; sifreli
 *       olmasinin anlami budur. Yani bir istemci "bende bu alan var" deyip
 *       bos gonderebilir.
 *
 *       Ama yalanin ZARARI SINIRLIDIR ve nerede durdugu bellidir:
 *
 *         - ISTATISTIK BOZULMAZ. Eksik deger sifreliyken elenir; kontenjans
 *           tablosuna ve `n` sayimina bitmap degil SIFRELI DEGER karar verir.
 *         - Yalnizca ODEME etkilenir: veri vermeden pay alinabilir.
 *
 *       BU YOL ARTIK VARSAYILAN DEGIL. `data_provenance` devresi bitmap'i ACIK
 *       CIKTI olarak veriyor; `submitRecord` ile yazilan kapsama uydurulamaz.
 *       Kaydi olan bir katilimcinin beyani ise yalnizca kanitin ALT KUMESI
 *       olabilir (`withinProven`) - yani yukaridaki yalan, kanit yolunu
 *       kullanan herkes icin KAPALIDIR.
 *
 *       Acik kalan tek durum: hic kanit gondermemis katilimci. Arayuz her
 *       zaman kanit gonderir; sozlesme bunu zorlamaz cunku kanitsiz yol
 *       testlerde ve kanit devresi olmayan veri turlerinde hala gerekli.
 */
library CoverageBits {
    /**
     * @notice Bir parti icin kapsama bitlerini yazar ve alan sayaclarini artirir.
     *
     * @param bits   `katilimci => kelime indeksi => bitler`
     * @param counts `alan => o alana veri vermis kisi sayisi`
     * @param from   Partinin ilk alan indeksi.
     * @param mask   Bit i, `from + i` alaninda GERCEK veri oldugunu soyler.
     * @param length Partideki alan sayisi.
     *
     * @return added Bu partide ilk kez kapsanan alan sayisi.
     *
     * @dev Ayni alan iki kez sayilmaz: bit zaten yaziliysa sayac artmaz.
     *      Artsaydi payda sisirilebilir ve herkesin payi seyrelirdi.
     */
    function record(
        mapping(address => mapping(uint256 => uint256)) storage bits,
        mapping(uint32 => uint32) storage counts,
        address who,
        uint32 from,
        uint256 mask,
        uint256 length
    ) public returns (uint32 added) {
        for (uint256 i = 0; i < length; ++i) {
            if (mask & (uint256(1) << i) == 0) continue;

            uint32 field = from + uint32(i);
            uint256 word = uint256(field) >> 8;
            uint256 bit = uint256(1) << (uint256(field) & 255);

            uint256 existing = bits[who][word];
            if (existing & bit != 0) continue; // zaten sayilmis

            bits[who][word] = existing | bit;
            counts[field] += 1;
            added += 1;
        }
    }

    /**
     * @notice BEYAN edilen bitlerin hepsi daha once KANITLA yazilmis mi.
     *
     * @dev  NEDEN AYRI BIR FONKSIYON
     *
     *       `record` yazar; bu yalnizca SORAR. Kullanildigi yer, ZK koken
     *       kaydi olan bir katilimcinin sifreli dozaj gonderdigi andir:
     *       kapsama zaten kanittan yazilmistir, istemcinin ayrica beyan
     *       ettigi maske yeni alan EKLEYEMEMELIDIR. Ekleyebilseydi kanit
     *       yolu bos yere kurulmus olurdu - saldirgan once dar bir kanit
     *       gonderip sonra maskeyle genisletirdi.
     *
     *       Doner deger `true` ise beyan kanitin ALT KUMESIDIR.
     */
    function withinProven(
        mapping(address => mapping(uint256 => uint256)) storage bits,
        address who,
        uint32 from,
        uint256 mask,
        uint256 length
    ) public view returns (bool) {
        for (uint256 i = 0; i < length; ++i) {
            if (mask & (uint256(1) << i) == 0) continue;
            if (!has(bits, who, from + uint32(i))) return false;
        }
        return true;
    }

    /// @notice Katilimcinin bu alanda gercek verisi var mi?
    function has(
        mapping(address => mapping(uint256 => uint256)) storage bits,
        address who,
        uint32 field
    ) public view returns (bool) {
        return bits[who][uint256(field) >> 8] & (uint256(1) << (uint256(field) & 255)) != 0;
    }

    /**
     * @notice ISTENEN alanlarin hangilerinde verisi oldugunu BIT MASKESI olarak doner.
     *
     * @dev  NEDEN MASKE, NEDEN TEK CAGRI
     *
     *       Kitliga gore odeme, alan basina AYRI bir agirlik kullanir; yani
     *       "kac alan" yetmez, "HANGI alanlar" gerekir. Alan basina bir
     *       `has` cagrisi, talep tavaninda (32 SNP + 16 metrik) onlarca
     *       harici staticcall demek olurdu.
     *
     *       Tavanlar maskeye SIGAR (32 ve 16, ikisi de 256'nin altinda), bu
     *       yuzden tek bir `uint256` her seyi tasir.
     *
     *       Bit i, `fields[i]` alanina karsilik gelir - alan indeksine degil
     *       LISTEDEKI SIRAYA. Agirlik dizisi de ayni sirada tutulur.
     */
    function maskOf(
        mapping(address => mapping(uint256 => uint256)) storage bits,
        address who,
        uint32[] memory fields
    ) public view returns (uint256 mask) {
        require(fields.length <= 256, "alan listesi maskeye sigmiyor");

        for (uint256 i = 0; i < fields.length; ++i) {
            if (has(bits, who, fields[i])) mask |= uint256(1) << i;
        }
    }

    /**
     * @notice Katilimcinin ISTENEN alanlardan kacinda verisi var?
     *
     * @dev Odeme payinin PAYIDIR. Payda, ayni alanlarin `counts` toplamidir;
     *      ikisi de O(istenen alan sayisi) oldugu icin maliyet KATILIMCI
     *      SAYISINDAN BAGIMSIZDIR. Tum katilimcilari dolasan bir tasarim
     *      binlerce kiside imkansiz olurdu.
     */
    function weight(
        mapping(address => mapping(uint256 => uint256)) storage bits,
        address who,
        uint32[] memory fields
    ) public view returns (uint32 matched) {
        for (uint256 i = 0; i < fields.length; ++i) {
            if (has(bits, who, fields[i])) matched += 1;
        }
    }

    /// @notice Istenen alanlarin kapsama sayaclarinin toplami - odemenin PAYDASI.
    function total(
        mapping(uint32 => uint32) storage counts,
        uint32[] memory fields
    ) public view returns (uint256 sum) {
        for (uint256 i = 0; i < fields.length; ++i) {
            sum += counts[fields[i]];
        }
    }
}
