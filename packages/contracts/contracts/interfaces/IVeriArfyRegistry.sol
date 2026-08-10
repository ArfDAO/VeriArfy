// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

/**
 * @title  IVeriArfyRegistry
 * @notice Kasanin (Vault) kimlik kaydini sorgulamak icin ihtiyac duydugu
 *         minimal arayuz. VeriArfyRegistry bu fonksiyonu saglar.
 */
interface IVeriArfyRegistry {
    function isRegistered(address account) external view returns (bool);
}
