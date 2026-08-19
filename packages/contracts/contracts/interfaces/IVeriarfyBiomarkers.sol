// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

/**
 * @title  IVeriarfyBiomarkers
 * @notice Protokolun surekli olcum modulunden ihtiyac duydugu YUZEY.
 *
 * @dev Kasitli olarak dardir: onay ve acilim dongusu protokolde KALIR, modul
 *      yalnizca veriyi tutar. Modul kendi basina kimseye cozum yetkisi
 *      veremez — `grantFor` yalnizca protokolden cagrilabilir.
 */
interface IVeriarfyBiomarkers {
    /// @notice Varsayilan acilim penceresinin buyuklugu (metrik sayisi, tavanla sinirli).
    function disclosureWindowSize() external view returns (uint32);

    /// @notice Talep icin `[from, to)` araligindaki toplamlari dondurur.
    function snapshotFor(uint256 requestId, uint32 from, uint32 to) external;

    /// @notice Dondurulmus toplamlarin cozum yetkisini arastirmaciya verir.
    function grantFor(uint256 requestId, address researcher) external;
}
