// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

/**
 * @title  IKMSVerifier
 * @notice Zama KMS dugumlerinin esikli cozum imzalarini ZINCIRDE dogrular.
 *
 * @dev  NEDEN BU ARAYUZ VAR
 *
 *       fhEVM 0.11.x'te sozlesmenin cagirabilecegi bir "cozum oracle'i
 *       geri cagrisi" (`requestDecryption` + callback) YOKTUR. Akis sudur:
 *
 *         1. Sozlesme `FHE.makePubliclyDecryptable(handle)` der.
 *         2. Herhangi biri relayer'a `publicDecrypt([handle])` cagirir.
 *         3. KMS dugumleri esigi saglarsa duz degeri ve EIP-712 imzalarini
 *            (`decryptionProof`) dondurur.
 *         4. Bu deger + kanit zincire geri gonderilir.
 *
 *       4. adim naif yazilirsa GUVENILIR BIR TARAF yaratir: sonucu getiren
 *       kisi yalan soyleyebilir. `verifyDecryptionEIP712KMSSignatures`,
 *       "bu handle gercekten bu degere cozuluyor" iddiasinin KMS esigi
 *       tarafindan imzalandigini dogrular. Boylece sonucu KIMIN getirdigi
 *       onemsizlesir — dogrulama zincirde yapilir.
 *
 *       Adres `ZamaConfig` uzerinden chainId'ye gore gelir; elle yazilmaz.
 *
 *       Arayuz surumu: KMSVerifier 0.10.0 — fhevm mock-utils paketiyle ayni.
 */
interface IKMSVerifier {
    /**
     * @param handlesList     Cozulen sifreli deger handle'lari (sirali).
     * @param decryptedResult Duz degerlerin ABI kodlamasi.
     * @param decryptionProof KMS dugumlerinin EIP-712 imzalari.
     * @return true — imzalar gecerli ve esik saglandi.
     */
    function verifyDecryptionEIP712KMSSignatures(
        bytes32[] memory handlesList,
        bytes memory decryptedResult,
        bytes memory decryptionProof
    ) external returns (bool);

    /// @notice Esik icin gereken KMS imza sayisi.
    function getThreshold() external view returns (uint256);
}
