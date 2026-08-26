// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {IGroth16Verifier} from "./interfaces/IGroth16Verifier.sol";

/**
 * @title   VeriArfyRegistry
 * @notice  Arastirmaci kimliklerinin zero-knowledge ile dogrulandigi kayit defteri.
 *
 * @dev Akis:
 *      1. Kurator (owner) akredite arastirmacilarin Poseidon taahhutlerini agaca ekler.
 *      2. Arastirmaci, taahhudunun agacta oldugunu ZK kanitla gosterir; kimligi acilmaz.
 *      3. Kanit `msg.sender`'a baglidir (signalHash) ve nullifier ile tek kullanimliktir.
 *
 *      Agacin kendisi zincir disinda tutulur; kontrat yalnizca gecerli koklerin
 *      gecmisini saklar. Boylece kok guncellenirken eski kanitlar bir sure gecerli kalir.
 */
contract VeriArfyRegistry {
    /// @notice Merkle agac derinligi - devredeki `ResearcherIdentity(20)` ile ayni olmali.
    uint256 public constant TREE_DEPTH = 20;

    /// @notice Kayit kapsami. Devreye `externalNullifier` olarak girer.
    uint256 public constant EXTERNAL_NULLIFIER = 1;

    /// @notice BN254 skaler alan mertebesi.
    uint256 internal constant SNARK_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    IGroth16Verifier public immutable verifier;

    address public owner;

    /// @notice Su anki akredite arastirmaci agacinin koku.
    uint256 public currentRoot;

    /// @notice Bir kokun ne zaman gecerli oldugu (0 = hic gecerli olmadi).
    mapping(uint256 root => uint256 timestamp) public rootTimestamp;

    /// @notice Eski koklerin kabul edildigi sure.
    uint256 public constant ROOT_VALIDITY = 1 hours;

    /// @notice Harcanmis nullifier'lar - ayni kimlik iki kez kayit olamaz.
    mapping(uint256 nullifierHash => bool spent) public nullifierSpent;

    /// @notice Kayitli cuzdanlar.
    mapping(address account => bool registered) public isRegistered;

    /// @notice Kayit sirasinda kullanilan nullifier (cuzdan -> nullifierHash).
    mapping(address account => uint256 nullifierHash) public registrationNullifier;

    uint256 public researcherCount;

    event RootUpdated(uint256 indexed newRoot, uint256 indexed previousRoot);
    event ResearcherRegistered(address indexed account, uint256 indexed nullifierHash);
    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error InvalidProof();
    error NullifierAlreadySpent(uint256 nullifierHash);
    error UnknownRoot(uint256 root);
    error RootExpired(uint256 root);
    error AlreadyRegistered(address account);
    error SignalMismatch();
    error ValueOutOfField();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address verifierAddress, uint256 initialRoot) {
        if (verifierAddress == address(0)) revert ZeroAddress();

        verifier = IGroth16Verifier(verifierAddress);
        owner = msg.sender;

        if (initialRoot != 0) {
            _setRoot(initialRoot);
        }
    }

    /**
     * @notice Akredite arastirmaci agacinin kokunu gunceller.
     * @dev Yeni bir taahhut eklendiginde zincir disinda hesaplanan kok buraya yazilir.
     *      Eski kok `ROOT_VALIDITY` suresince gecerli kalir; boylece kanit ureten
     *      kullanicilar guncelleme yuzunden basarisiz olmaz.
     */
    function updateRoot(uint256 newRoot) external onlyOwner {
        if (newRoot == 0 || newRoot >= SNARK_FIELD) revert ValueOutOfField();
        _setRoot(newRoot);
    }

    function _setRoot(uint256 newRoot) internal {
        uint256 previous = currentRoot;
        currentRoot = newRoot;
        rootTimestamp[newRoot] = block.timestamp;
        emit RootUpdated(newRoot, previous);
    }

    /**
     * @notice ZK kanit ile arastirmaci olarak kayit olur.
     * @param  root          Kanitin uretildigi Merkle koku.
     * @param  nullifierHash Poseidon(EXTERNAL_NULLIFIER, identityNullifier).
     * @param  pA/pB/pC      Groth16 kanit bilesenleri.
     *
     * @dev `signalHash` olarak `uint256(uint160(msg.sender))` beklenir; bu sayede
     *      bir kanit baska bir cuzdan tarafindan kullanilamaz (front-running korumasi).
     */
    function register(
        uint256 root,
        uint256 nullifierHash,
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC
    ) external {
        if (isRegistered[msg.sender]) revert AlreadyRegistered(msg.sender);
        if (nullifierSpent[nullifierHash]) revert NullifierAlreadySpent(nullifierHash);

        _validateRoot(root);

        uint256[4] memory publicSignals = [
            root,
            nullifierHash,
            EXTERNAL_NULLIFIER,
            uint256(uint160(msg.sender))
        ];

        if (!verifier.verifyProof(pA, pB, pC, publicSignals)) revert InvalidProof();

        nullifierSpent[nullifierHash] = true;
        isRegistered[msg.sender] = true;
        registrationNullifier[msg.sender] = nullifierHash;

        unchecked {
            researcherCount++;
        }

        emit ResearcherRegistered(msg.sender, nullifierHash);
    }

    function _validateRoot(uint256 root) internal view {
        if (root == currentRoot) return;

        uint256 timestamp = rootTimestamp[root];
        if (timestamp == 0) revert UnknownRoot(root);
        if (block.timestamp > timestamp + ROOT_VALIDITY) revert RootExpired(root);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }
}
