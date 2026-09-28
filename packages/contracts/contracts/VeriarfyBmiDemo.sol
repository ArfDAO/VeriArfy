// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, euint16, euint32, externalEuint16} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * @title VeriarfyBmiDemo
 * @notice Synthetic-only Teknofest BMI parity demonstration.
 *
 * @dev This contract is deliberately separate from VeriarfyProtocolE18. It
 *      does not enroll a person, affect research aggregates, or relax E/18's
 *      30+30 disclosure policy. The caller supplies public height in cm and
 *      encrypted weight in deci-kg. The contract calculates BMI x100 with
 *      fhEVM arithmetic, then makes only the final BMI publicly decryptable.
 *
 *      Public decryption is an intentional, narrowly scoped demo exception:
 *      use synthetic presentation data only. It is not a clinical feature and
 *      must never receive real-person health data.
 */
contract VeriarfyBmiDemo is ZamaEthereumConfig {
    uint16 public constant MIN_HEIGHT_CM = 100;
    uint16 public constant MAX_HEIGHT_CM = 250;
    uint16 public constant MAX_WEIGHT_DECI_KG = 3000;
    uint32 public constant BMI_SCALE = 100;

    mapping(address account => euint32) private _bmiHandle;

    event BmiCalculated(address indexed demonstrator, uint16 indexed heightCm, bytes32 bmiHandle);

    error InvalidHeight(uint16 heightCm);

    /**
     * @notice Calculates BMI x100 from encrypted weight and public height.
     * @param encryptedWeightDeciKg encrypted kg*10 input bound to this contract.
     * @param heightCm public integer height in cm; used as the division denominator.
     * @param inputProof fhEVM encrypted-input proof for `encryptedWeightDeciKg`.
     * @return BMI x100 encrypted handle, publicly decryptable only by this demo policy.
     */
    function calculate(
        externalEuint16 encryptedWeightDeciKg,
        uint16 heightCm,
        bytes calldata inputProof
    ) external returns (euint32) {
        if (heightCm < MIN_HEIGHT_CM || heightCm > MAX_HEIGHT_CM) revert InvalidHeight(heightCm);

        euint16 submittedWeight = FHE.fromExternal(encryptedWeightDeciKg, inputProof);
        // Range-bound encrypted input prevents a malformed demo input from
        // overflowing the public fixed-point conversion below.
        euint16 boundedWeight = FHE.min(submittedWeight, FHE.asEuint16(MAX_WEIGHT_DECI_KG));
        euint32 numerator = FHE.mul(FHE.asEuint32(boundedWeight), uint32(100_000));
        uint32 heightSquared = uint32(heightCm) * uint32(heightCm);
        euint32 bmi = FHE.div(numerator, heightSquared);

        _bmiHandle[msg.sender] = bmi;
        FHE.allowThis(bmi);
        FHE.makePubliclyDecryptable(bmi);

        emit BmiCalculated(msg.sender, heightCm, euint32.unwrap(bmi));
        return bmi;
    }

    /** @notice Latest encrypted BMI handle for a demo caller. */
    function bmiHandle(address demonstrator) external view returns (euint32) {
        return _bmiHandle[demonstrator];
    }
}
