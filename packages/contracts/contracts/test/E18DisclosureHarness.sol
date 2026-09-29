// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, euint32, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ContingencyStats} from "../libraries/ContingencyStats.sol";
import {BiomarkerStats} from "../libraries/BiomarkerStats.sol";

/// @dev Test-only synthetic fixture. Plaintext seed methods must never be deployed for real data.
contract E18DisclosureHarness is ZamaEthereumConfig {
    mapping(uint32 => euint32[3][2]) private _snpRaw;
    mapping(uint32 => euint32[3][2]) private _snpSafe;
    mapping(uint32 => BiomarkerStats.Accumulator[2]) private _metricRaw;
    mapping(uint32 => BiomarkerStats.Accumulator[2]) private _metricSafe;

    function seedSnp(uint32[3][2] calldata cells) external {
        for (uint8 g = 0; g < 2; ++g) {
            for (uint8 d = 0; d < 3; ++d) {
                euint32 value = FHE.asEuint32(cells[g][d]);
                _snpRaw[0][g][d] = value;
                FHE.allowThis(value);
            }
        }
    }

    function grantSnpSafe(address researcher) external {
        ContingencyStats.grantSafe(_snpRaw, _snpSafe, 0, researcher);
    }

    function rawSnp() external view returns (euint32[3][2] memory) {
        return _snpRaw[0];
    }

    function safeSnp() external view returns (euint32[3][2] memory) {
        return _snpSafe[0];
    }

    function seedMetric(uint32[2] calldata counts, uint64[2] calldata sums, uint64[2] calldata sumSquares) external {
        for (uint8 g = 0; g < 2; ++g) {
            BiomarkerStats.Accumulator storage acc = _metricRaw[0][g];
            acc.count = FHE.asEuint32(counts[g]);
            acc.sum = FHE.asEuint64(sums[g]);
            acc.sumSq = FHE.asEuint64(sumSquares[g]);
            FHE.allowThis(acc.count);
            FHE.allowThis(acc.sum);
            FHE.allowThis(acc.sumSq);
        }
    }

    function grantMetricSafe(address researcher) external {
        BiomarkerStats.grantSafe(_metricRaw, _metricSafe, 0, researcher);
    }

    function rawMetric(uint8 group) external view returns (euint64 sum, euint64 sumSq, euint32 count) {
        BiomarkerStats.Accumulator storage acc = _metricRaw[0][group];
        return (acc.sum, acc.sumSq, acc.count);
    }

    function safeMetric(uint8 group) external view returns (euint64 sum, euint64 sumSq, euint32 count) {
        BiomarkerStats.Accumulator storage acc = _metricSafe[0][group];
        return (acc.sum, acc.sumSq, acc.count);
    }
}
