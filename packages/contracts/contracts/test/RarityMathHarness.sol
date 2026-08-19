// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {RarityMath} from "../libraries/RarityMath.sol";

/**
 * @title  RarityMathHarness
 * @notice `RarityMath` kutuphanesini disaridan cagrilabilir kilan test kabugu.
 *
 * @dev  BU BIR MOCK DEGILDIR.
 *
 *       Icinde HICBIR mantik yoktur; her fonksiyon uretimde kullanilan
 *       kutuphaneye birebir devreder. Var olma sebebi tek: `internal pure`
 *       fonksiyonlar zincir disindan cagrilamaz, ve nadirlik carpanini
 *       raporun 100.000 kisilik ornegiyle dogrulamak icin o buyuklukte gercek
 *       bir havuz kurmak mumkun degildir.
 *
 *       Yani test edilen sey uretim kodudur; kabuk yalnizca kapiyi acar.
 *       Uretim dagitiminda bu kontrat DEPLOY EDILMEZ.
 */
contract RarityMathHarness {
    function multiplierBps(uint32 poolCount, uint32 carriers) external pure returns (uint256) {
        return RarityMath.multiplierBps(poolCount, carriers);
    }

    function withFoundingBonus(uint256 weightBps) external pure returns (uint256) {
        return RarityMath.withFoundingBonus(weightBps);
    }

    function oneBps() external pure returns (uint256) {
        return RarityMath.ONE_BPS;
    }
}
