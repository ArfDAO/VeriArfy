// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

/**
 * @title  RarityMath
 * @notice Rapor 4.3'teki Nadirlik Carpani: `R = log2(1 + N_total / N_variant)`.
 *
 * @dev  NEDEN AYRI KUTUPHANE
 *
 *       Formul logaritma icerir; Solidity'de `log2` yoktur ve kesirli kismi
 *       olmadan formul anlamsizlasir (tam sayi `log2` 2000 ile 4095 arasindaki
 *       her havuza ayni carpani verirdi). Bu yuzden sabit noktali bir uygulama
 *       gerekiyor - ve bagimsiz test edilebilmesi icin odeme mantigindan
 *       ayrildi.
 *
 *       OLCEK
 *       Carpanlar BAZ PUAN (bps) cinsindendir: 10.000 = 1,00x.
 *       Raporun ornegi (N=100.000, C=50) burada 109.670 bps ~= 10,97x cikar;
 *       rapor "yaklasik 11 kat" diyor.
 *
 *       TASMA
 *       Ic hesap Q64.64 sabit noktadir. `y * y` en fazla 2^130 mertebesindedir,
 *       uint256'ya rahat sigar. `(N + C)` uint32 toplamidir; 64 bit kaydirma
 *       sonrasi bile 2^96 civarinda kalir.
 */
library RarityMath {
    /// @notice 1,00x carpaninin baz puan karsiligi.
    uint256 internal constant ONE_BPS = 10_000;

    /// @notice Kurucu Katkici bonusu sonrasi carpan: 1,00x -> 1,50x.
    uint256 internal constant FOUNDING_BPS = 15_000;

    /**
     * @notice Kurucu Katkici bonusunu uygular (rapor 4.3: kalici +%50).
     *
     * @dev  Hem BIREYSEL agirlikta hem TOPLAM agirlikta ayni fonksiyon
     *       kullanilmalidir. Tek satirlik bir tam sayi bolmesi gibi gorunse de,
     *       iki yerde farkli sirayla yazilsaydi (`w*3/2` ve `w*15000/10000`)
     *       tek bir baz puanlik yuvarlama farki paylarin toplamini havuzdan
     *       BUYUK yapabilirdi.
     */
    function withFoundingBonus(uint256 weightBps) internal pure returns (uint256) {
        return (weightBps * 3) / 2;
    }

    /**
     * @notice `R = log2(1 + poolCount / carriers)` - baz puan cinsinden.
     *
     * @dev Tasiyici yoksa carpan tanimsizdir (sifira bolme); 0 doner ve
     *      cagiran taraf o terimi zaten toplama katmaz.
     *
     *      Tasiyici sayisi havuzun tamamina esitse `R = log2(2) = 1,00x` olur -
     *      yani "herkes tasiyor" durumunda nadirlik primi yoktur. Formulun
     *      kendisi bu tabana oturur.
     */
    function multiplierBps(uint32 poolCount, uint32 carriers) internal pure returns (uint256) {
        if (carriers == 0 || poolCount == 0) return 0;

        // (1 + N/C) degerini Q64.64 sabit noktada kur.
        uint256 x = ((uint256(poolCount) + uint256(carriers)) << 64) / uint256(carriers);

        return (_log2Q64(x) * ONE_BPS) >> 64;
    }

    /**
     * @notice Q64.64 sabit noktali ikili logaritma.
     *
     * @dev  Standart iki asamali algoritma:
     *
     *       1. Tam kisim: kac kez 2'ye bolunebiliyor.
     *       2. Kesirli kisim: kalan [1,2) araligindaki deger tekrar tekrar
     *          KARESI alinir. Kare 2'yi asarsa o basamagin biti 1'dir ve deger
     *          ikiye bolunur. Bu, log2'nin ikili aciliminin basamak basamak
     *          okunmasidir - `log2(y^2) = 2*log2(y)` ozdesligi.
     *
     *       Girdi >= 2^64 (yani deger >= 1) olmalidir; nadirlik formulunde
     *       `1 + N/C` her zaman > 1'dir.
     */
    function _log2Q64(uint256 x) private pure returns (uint256 result) {
        // --- tam kisim ---
        uint256 n;
        uint256 v = x >> 64;
        while (v > 1) {
            v >>= 1;
            n++;
        }
        result = n << 64;

        // --- kesirli kisim ---
        uint256 y = x >> n; // [1, 2) araligina normalize, hala Q64.64
        if (y == 1 << 64) return result;

        for (uint256 delta = 1 << 63; delta > 0; delta >>= 1) {
            y = (y * y) >> 64;
            if (y >= 2 << 64) {
                y >>= 1;
                result += delta;
            }
        }
    }
}
