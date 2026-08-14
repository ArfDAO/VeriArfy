// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title   StableTestToken
 * @notice  Test aglari icin USDC yerine gecen ERC-20.
 *
 * @dev
 * # Bu bir "mock" DEGILDIR
 *
 * Govde OpenZeppelin'in denetlenmis `ERC20` uygulamasidir; hicbir kontrol
 * atlanmaz, hicbir davranis taklit edilmez. `VeriarfyPayments` bu token ile
 * calisirken gercek `transferFrom` / `transfer` / `allowance` yolundan gecer.
 *
 * Ayrim onemli: bir sahte DOGRULAYICI guvenlik kontrolunu devre disi birakir
 * ve testi anlamsizlastirir. Gercek bir ERC-20 uygulamasi ise hicbir seyi
 * devre disi birakmaz — yalnizca Circle'in bastigi USDC yerine bizim
 * bastigimiz bir token kullanilir.
 *
 * # Uretimde
 *
 * Kullanilmaz. `VeriarfyPayments` yapicisina gercek USDC adresi verilir
 * (Sepolia: Circle'in test USDC'si; mainnet: USDC). Adres ortam degiskeniyle
 * gecilir — bkz. `scripts/deploy.ts`, `PAYMENT_TOKEN`.
 *
 * # Ondalik
 *
 * 6 basamak: USDC ile ayni. Farkli olsaydi fiyat sabitleri test ile uretim
 * arasinda sessizce 10^12 kat sapardi.
 */
contract StableTestToken is ERC20, Ownable {
    constructor(address initialOwner)
        ERC20("VeriArfy Test USD", "tUSD")
        Ownable(initialOwner)
    {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Test aglarinda bakiye dagitmak icin. Uretimde bu kontrat yoktur.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
