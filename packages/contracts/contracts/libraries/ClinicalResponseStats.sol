// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.24;

import {FHE, ebool, euint8, euint32} from "@fhevm/solidity/lib/FHE.sol";

/// @notice Encrypted 2x2 group/response sufficient statistics for E/19.
library ClinicalResponseStats {
    uint8 internal constant GROUPS = 2;
    uint8 internal constant RESPONSES = 2;

    function initialize(mapping(uint32 => euint32[2][2]) storage table, uint32 endpoint) public {
        for (uint8 group = 0; group < GROUPS; ++group) {
            for (uint8 response = 0; response < RESPONSES; ++response) {
                euint32 zero = FHE.asEuint32(0);
                table[endpoint][group][response] = zero;
                FHE.allowThis(zero);
            }
        }
    }

    function accumulate(
        mapping(uint32 => euint32[2][2]) storage table,
        uint32 endpoint,
        euint8 response,
        ebool inControl,
        ebool inCase
    ) public {
        ebool[2] memory inGroup = [inControl, inCase];
        for (uint8 value = 0; value < RESPONSES; ++value) {
            ebool hasResponse = FHE.eq(response, value);
            for (uint8 group = 0; group < GROUPS; ++group) {
                euint32 next = FHE.add(
                    table[endpoint][group][value],
                    FHE.asEuint32(FHE.and(inGroup[group], hasResponse))
                );
                table[endpoint][group][value] = next;
                FHE.allowThis(next);
            }
        }
    }

    function snapshot(
        mapping(uint32 => euint32[2][2]) storage live,
        mapping(uint32 => euint32[2][2]) storage frozen,
        uint32 endpoint
    ) public {
        for (uint8 group = 0; group < GROUPS; ++group) {
            for (uint8 response = 0; response < RESPONSES; ++response) {
                frozen[endpoint][group][response] = live[endpoint][group][response];
                FHE.allowThis(frozen[endpoint][group][response]);
            }
        }
    }

    function grantSafe(
        mapping(uint32 => euint32[2][2]) storage frozen,
        mapping(uint32 => euint32[2][2]) storage released,
        uint32 endpoint,
        address researcher
    ) public {
        ebool eligible = FHE.asEbool(true);
        for (uint8 group = 0; group < GROUPS; ++group) {
            euint32 groupCount = FHE.asEuint32(0);
            for (uint8 response = 0; response < RESPONSES; ++response) {
                euint32 cell = frozen[endpoint][group][response];
                eligible = FHE.and(eligible, FHE.ge(cell, 5));
                groupCount = FHE.add(groupCount, cell);
            }
            eligible = FHE.and(eligible, FHE.ge(groupCount, 30));
        }

        euint32 zero = FHE.asEuint32(0);
        for (uint8 group = 0; group < GROUPS; ++group) {
            for (uint8 response = 0; response < RESPONSES; ++response) {
                euint32 masked = FHE.select(eligible, frozen[endpoint][group][response], zero);
                released[endpoint][group][response] = masked;
                FHE.allowThis(masked);
                FHE.allow(masked, researcher);
            }
        }
    }
}
