// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, euint32, externalEuint32, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

import {IVeriArfyRegistry} from "./interfaces/IVeriArfyRegistry.sol";

/**
 * @title   VeriArfyVault
 * @notice  Sifreli biyoinformatik veri paylasim kasasi (Zama FHEVM).
 *
 * @dev Akis:
 *      1. Kullanici once VeriArfyRegistry uzerinden ZK ile arastirmaci olur.
 *      2. Ham veri (or. bir genomik risk skoru / marker degeri) istemci
 *         tarafinda FHE ile sifrelenir; zincire yalnizca sifreli metin (handle)
 *         ve icin bir metadata (veri turu + off-chain ciphertext blob'un hash'i)
 *         yazilir. Duz deger asla zincire ulasmaz.
 *      3. Sahip, sifreli kaydin cozulme (decrypt) yetkisini baska kayitli
 *         arastirmacilara verebilir — veri paylasilir ama gizli kalir.
 *      4. Kohort istatistigi tamamen sifreli alanda homomorfik olarak birikir:
 *         toplam ve sayac hicbir zaman acilmadan guncellenir.
 *
 *      Duz metin, veri turu (DatasetKind) ve ciphertext'in IPFS/Arweave
 *      referansi disinda hicbir sey aciga cikmaz.
 */
contract VeriArfyVault is SepoliaConfig {
    /// @notice Pastel kategori setiyle birebir eslesen veri turleri.
    enum DatasetKind {
        Genomics, // violet
        Proteomics, // pembe
        Transcriptomics, // seftali
        Metabolomics, // nane
        Epigenomics, // mavi
        Microbiome // yesil
    }

    struct Record {
        address owner;
        DatasetKind kind;
        uint64 submittedAt;
        bytes32 payloadHash; // off-chain ciphertext blob (IPFS CID vb.) tamlik hash'i
        euint32 value; // FHE ile sifreli olcum
    }

    IVeriArfyRegistry public immutable registry;
    address public owner;

    uint256 public recordCount;
    mapping(uint256 recordId => Record) private _records;
    mapping(address account => uint256[] ids) private _recordsOf;

    /// @notice Her veri turu icin homomorfik kohort birikimi (sifreli toplam).
    mapping(DatasetKind kind => euint32 encryptedSum) private _cohortSum;
    /// @notice Her veri turune katki veren kayit sayisi (duz — birey aciga cikmaz).
    mapping(DatasetKind kind => uint32 count) public cohortCount;

    event RecordSubmitted(
        uint256 indexed recordId,
        address indexed owner,
        DatasetKind indexed kind,
        bytes32 payloadHash
    );
    event AccessGranted(uint256 indexed recordId, address indexed grantee);
    event AccessRevoked(uint256 indexed recordId, address indexed grantee);
    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);

    error NotRegistered(address account);
    error NotRecordOwner(uint256 recordId);
    error UnknownRecord(uint256 recordId);
    error NotOwner();
    error ZeroAddress();

    modifier onlyRegistered() {
        if (!registry.isRegistered(msg.sender)) revert NotRegistered(msg.sender);
        _;
    }

    modifier onlyRecordOwner(uint256 recordId) {
        if (recordId >= recordCount) revert UnknownRecord(recordId);
        if (_records[recordId].owner != msg.sender) revert NotRecordOwner(recordId);
        _;
    }

    constructor(address registryAddress) {
        if (registryAddress == address(0)) revert ZeroAddress();
        registry = IVeriArfyRegistry(registryAddress);
        owner = msg.sender;
    }

    /**
     * @notice Sifreli bir olcum kaydini kasaya yukler.
     * @param  kind          Veri turu (kategori).
     * @param  payloadHash   Off-chain sifreli blob'un tamlik hash'i (0 olabilir).
     * @param  encryptedValue Istemcide uretilen dis sifreli handle.
     * @param  inputProof    Relayer'in urettigi girdi ispati.
     * @return recordId      Yeni kaydin kimligi.
     *
     * @dev `FHE.fromExternal` handle'i dogrular ve kontrata baglar. Kohort
     *      toplami homomorfik olarak guncellenir; hicbir asamada duz deger yok.
     */
    function submitRecord(
        DatasetKind kind,
        bytes32 payloadHash,
        externalEuint32 encryptedValue,
        bytes calldata inputProof
    ) external onlyRegistered returns (uint256 recordId) {
        euint32 value = FHE.fromExternal(encryptedValue, inputProof);

        recordId = recordCount++;
        Record storage rec = _records[recordId];
        rec.owner = msg.sender;
        rec.kind = kind;
        rec.submittedAt = uint64(block.timestamp);
        rec.payloadHash = payloadHash;
        rec.value = value;

        _recordsOf[msg.sender].push(recordId);

        // Kaydin kendi degerine kontrat + sahip erisebilsin.
        FHE.allowThis(value);
        FHE.allow(value, msg.sender);

        _accumulateCohort(kind, value);

        emit RecordSubmitted(recordId, msg.sender, kind, payloadHash);
    }

    /// @dev Sifreli toplami homomorfik olarak buyutur ve erisim izinlerini korur.
    function _accumulateCohort(DatasetKind kind, euint32 value) internal {
        euint32 running = _cohortSum[kind];
        // Ilk katkida toplam bos handle; FHE.add bos handle'i 0 kabul eder.
        euint32 updated = FHE.add(running, value);
        _cohortSum[kind] = updated;
        cohortCount[kind] += 1;

        // Toplam gelecekte cozulebilsin diye kontrata ve kasa sahibine izin ver.
        FHE.allowThis(updated);
        FHE.allow(updated, owner);
    }

    /**
     * @notice Bir kaydin cozme yetkisini baska bir kayitli arastirmaciya verir.
     * @dev Grantee de kayitli olmali; veri yalnizca ekosistem icinde dolasir.
     */
    function grantAccess(uint256 recordId, address grantee)
        external
        onlyRecordOwner(recordId)
    {
        if (grantee == address(0)) revert ZeroAddress();
        if (!registry.isRegistered(grantee)) revert NotRegistered(grantee);

        FHE.allow(_records[recordId].value, grantee);
        emit AccessGranted(recordId, grantee);
    }

    /**
     * @notice Verilen erisimi kaldirir.
     * @dev FHE ACL'de kalici iptal, degeri yeni bir handle'a "yeniden gizleyerek"
     *      yapilir; boylece eski handle uzerindeki izinler gecersizlesir.
     */
    function revokeAccess(uint256 recordId, address grantee)
        external
        onlyRecordOwner(recordId)
    {
        Record storage rec = _records[recordId];
        euint32 resealed = FHE.add(rec.value, FHE.asEuint32(0));
        rec.value = resealed;

        FHE.allowThis(resealed);
        FHE.allow(resealed, rec.owner);

        emit AccessRevoked(recordId, grantee);
    }

    // --- Gorunumler -----------------------------------------------------------

    /// @notice Bir kaydin duz metadata'sini dondurur (sifreli deger haric).
    function recordMeta(uint256 recordId)
        external
        view
        returns (address recOwner, DatasetKind kind, uint64 submittedAt, bytes32 payloadHash)
    {
        if (recordId >= recordCount) revert UnknownRecord(recordId);
        Record storage rec = _records[recordId];
        return (rec.owner, rec.kind, rec.submittedAt, rec.payloadHash);
    }

    /// @notice Bir kaydin sifreli deger handle'ini dondurur (decrypt istemcide).
    function recordValue(uint256 recordId) external view returns (euint32) {
        if (recordId >= recordCount) revert UnknownRecord(recordId);
        return _records[recordId].value;
    }

    /// @notice Bir hesabin sahip oldugu tum kayit kimlikleri.
    function recordsOf(address account) external view returns (uint256[] memory) {
        return _recordsOf[account];
    }

    /// @notice Bir veri turunun sifreli kohort toplami handle'i.
    function cohortSum(DatasetKind kind) external view returns (euint32) {
        return _cohortSum[kind];
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }
}
