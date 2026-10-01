// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title   AccreditationLog
 * @notice  Dogrulanmis arastirmacilarin kalici listesi ve tekillik defteri.
 *
 * @dev
 * # Neden zincirde
 *
 * Kurator onayli taahhutleri sunucunun diskinde tutuyordu. Barindirildigi
 * ucretsiz ortamda disk KALICI DEGIL: servis her uyudugunda, yeniden
 * basladiginda ya da yeniden dagitildiginda yazilanlar siliniyor. Liste depodaki
 * ilk haline donuyor ve kok zincire eski haliyle yeniden yaziliyordu.
 *
 * Daha onemlisi "kisi basina tek kimlik" kurali boyle bir diskle
 * uygulanamazdi: kullanilmis e-posta kaydi her uykuda kaybolur ve ayni kisi
 * ayni adresle yeniden kaydolabilirdi. Liste ve tekillik defteri bu yuzden
 * burada; kurator acilista listeyi buradan yeniden kurar.
 *
 * # Gizlilik
 *
 * E-posta adresi ve ORCID iD zincire YAZILMAZ. Yazilan, kuratorun gizli
 * anahtariyla uretilmis HMAC ozetleridir (`identityKey`). Anahtari bilmeyen
 * biri bir ozetin hangi adrese ait oldugunu deneyerek bulamaz; e-posta alani
 * kucuk oldugu icin duz bir hash burada yetmezdi.
 *
 * Taahhut ile ozet ayni islemde gorunur. Bu, taahhudu kisiye BAGLAMAZ:
 * zincirde islem yapan cuzdanin hangi taahhude ait oldugu ZK kaydi ile
 * gizlidir (nullifier taahhutten turetilemez).
 *
 * # Guven
 *
 * Bu sozlesme kuratore guvenir: sahibi (kurator) kimi listeye ekleyecegine
 * karar verir. Bu guveni kaldirmak ayri bir asamadir (e-postanin DKIM
 * imzasini ZK devresinde dogrulamak).
 */
contract AccreditationLog is Ownable {
    /// @notice BN254 skaler alan mertebesi - taahhut devre alaninda olmali.
    uint256 internal constant SNARK_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /// @notice Kanit turleri. Sayi ne kadar buyukse kanit o kadar guclu.
    uint8 public constant EVIDENCE_MANUAL_REVIEW = 1; // YOK Akademik / AVESIS, operator incelemesi
    uint8 public constant EVIDENCE_ORCID_SELF = 2; // ORCID'de kurum kaydini kisi kendisi girmis
    uint8 public constant EVIDENCE_ORCID_INSTITUTION = 3; // ORCID'de kurum kaydini kurum sistemi girmis

    /// @notice Kullanilmis kimlik ozetleri (HMAC(e-posta), HMAC(ORCID iD)).
    mapping(bytes32 => bool) public identityUsed;

    /// @notice Listede olan taahhutler.
    mapping(uint256 => bool) public commitmentUsed;

    /// @notice Onay sirasina gore taahhutler; kurator agaci bu siradan kurar.
    uint256[] private _commitments;

    event Accredited(uint256 indexed index, uint256 commitment, uint8 evidence);

    error InvalidCommitment();
    error InvalidIdentityKey();
    error InvalidEvidence(uint8 evidence);
    error IdentityAlreadyUsed(bytes32 identityKey);
    error CommitmentAlreadyListed(uint256 commitment);

    constructor(address curator) Ownable(curator) {}

    /**
     * @notice Dogrulanmis bir arastirmacinin taahhudunu listeye ekler.
     * @param commitment  Tarayicida uretilen kimligin acik taahhudu.
     * @param emailKey    HMAC(normalize edilmis kurum e-postasi). Zorunlu.
     * @param profileKey  HMAC(ORCID iD) ya da HMAC(profil adresi); yoksa 0.
     * @param evidence    Kanit turu (EVIDENCE_*).
     *
     * @dev Ayni e-posta ya da ayni profil ikinci kez kullanilamaz. Bu, bir
     *      kisinin birden fazla, birbirine baglanamayan arastirmaci kimligi
     *      acmasini engeller - ki ZK kaydi kimlikleri bilerek baglanamaz
     *      kildigi icin baska hicbir yerde yakalanamazdi.
     */
    function accredit(
        uint256 commitment,
        bytes32 emailKey,
        bytes32 profileKey,
        uint8 evidence
    ) external onlyOwner {
        if (commitment == 0 || commitment >= SNARK_FIELD) revert InvalidCommitment();
        if (emailKey == bytes32(0)) revert InvalidIdentityKey();
        if (evidence < EVIDENCE_MANUAL_REVIEW || evidence > EVIDENCE_ORCID_INSTITUTION) {
            revert InvalidEvidence(evidence);
        }
        if (commitmentUsed[commitment]) revert CommitmentAlreadyListed(commitment);
        if (identityUsed[emailKey]) revert IdentityAlreadyUsed(emailKey);
        if (profileKey != bytes32(0)) {
            if (profileKey == emailKey) revert InvalidIdentityKey();
            if (identityUsed[profileKey]) revert IdentityAlreadyUsed(profileKey);
            identityUsed[profileKey] = true;
        }

        identityUsed[emailKey] = true;
        commitmentUsed[commitment] = true;
        _commitments.push(commitment);

        emit Accredited(_commitments.length - 1, commitment, evidence);
    }

    function commitmentCount() external view returns (uint256) {
        return _commitments.length;
    }

    /// @notice Sayfalayarak okuma: liste buyudukce tek cagrida donmek RPC sinirini asar.
    function commitmentsFrom(uint256 start, uint256 count) external view returns (uint256[] memory out) {
        uint256 total = _commitments.length;
        if (start >= total) return new uint256[](0);
        uint256 end = start + count > total ? total : start + count;
        out = new uint256[](end - start);
        for (uint256 i = start; i < end; ++i) out[i - start] = _commitments[i];
    }
}
