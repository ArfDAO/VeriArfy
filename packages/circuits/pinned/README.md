# D/15 frozen proof artifacts

`d15-proof-artifacts-v1.zip` is a versioned recovery copy of the existing
development-ceremony artifacts used by the nonce-24 redeployment. It contains
public proving/verification material, not wallet keys, witnesses, or user data.
No new ceremony was performed.

Archive SHA256:
`4a4484657cb9d53908e0c5aa3dc49c46b8e4e099832c9a34df2a408d1ecdd794`

Verify the archive hash before extracting it to a new directory. The nine
entries are flattened; restore them to the following paths, preserving any
different existing artifacts before replacement:

| Archive entry | Repository destination |
| --- | --- |
| `*_final.zkey`, `*_verification_key.json` | `packages/circuits/build/` |
| `researcher_identity.wasm` | `packages/circuits/build/researcher_identity_js/` |
| `data_provenance.wasm` | `packages/circuits/build/data_provenance_js/` |
| `Groth16Verifier.sol`, `DataProvenanceVerifier.sol` | `packages/contracts/contracts/verifiers/` |
| `artifacts.lock.json` | `packages/circuits/` |

Then run `node packages/circuits/scripts/check-artifacts.mjs` and compile the
contracts before preparing a deployment. The checker validates artifact hashes,
the verification keys exported from the zkeys, and both Solidity verifier
exports. Solidity text hashes normalize CRLF to LF for Windows checkouts.

Ordinary circuit builds/CI may use a separate development ceremony. They must
not update this lock or recovery bundle. D/15 deployment preparation refuses
such artifacts; restore this frozen set explicitly before resuming D/15 work.
`check-artifacts.mjs --export` only re-exports verifier sources after all three
input pins (WASM, proving key, verification key) have passed.
