// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

/**
 * @title  IVeriarfyStaking
 * @notice Protokolun kripto-ekonomik guvenlik modulunden bekledigi tek sey.
 *
 * @dev Arayuz KASITLI OLARAK dardir: protokol, teminatin nasil tutuldugunu,
 *      nasil kesildigini ya da itirazlarin nasil oylandigini bilmek zorunda
 *      degildir. Yalnizca "bu dugum oy kullanabilir mi" sorusunu sorar.
 *      Boylece guvenlik modulu, protokol degismeden yenilenebilir.
 */
interface IVeriarfyStaking {
    /// @notice Dugum yeterli teminata sahip ve yasakli degil mi?
    function canApprove(address node) external view returns (bool);

    /// @notice Acilim, cozulmemis bir itiraz yuzunden bekliyor mu?
    function isBlocked(uint256 requestId) external view returns (bool);
}
