# D/17: Sepolia multi-participant verification

D/17 adds three synthetic participants to the existing D/15 Sepolia deployment.
All three cover SNP 0; only the first also covers SNP 1. The original D/15
participant covers both fields and remains part of the query snapshot. This
checks scarcity-weighted payments using separate participant accounts, real
provenance proofs, FHE contributions, node approvals, settlement, and claims.

The local equivalent is `packages/contracts/test/MultiParticipant.test.ts`. It
covers three and five participants, plus the existing-participant baseline.
Its FHE operations use Hardhat mocks; live evidence must come from Sepolia.

## Signing and custody

The launcher is `scripts/d17-sepolia.cjs`. It starts one role process at a time.
The coordinator handles public addresses and status only. Each signing process
loads one role's key and checks its address against the public deployment.

Existing operator keys belong in these separate, Git-ignored local files:

| Role | Local file | Variable |
| --- | --- | --- |
| Deployer / researcher | `.env.d17.deployer` | `DEPLOYER_PRIVATE_KEY` |
| Node 1 | `.env.d17.node-1` | `NODE_PRIVATE_KEY` |
| Node 2 | `.env.d17.node-2` | `NODE_PRIVATE_KEY` |

New participant keys are created in separate child processes and protected
with Windows DPAPI for the current Windows user. Encrypted wallet files live
under `%LOCALAPPDATA%\VeriArfy\d17\wallets`. Keep these files and the Windows
user profile available for recovery. The public address manifest is
`packages/contracts/ops/d17-wallets.json`; it contains no private keys.

```powershell
node scripts/d17-sepolia.cjs --init-wallets --participants 3
node scripts/d17-sepolia.cjs --stage preflight --role none
node scripts/d17-sepolia.cjs --stage init --role none
```

Wallet initialization is local. Preflight reads Sepolia without loading signer
keys. Initialization records the existing participant and coverage baseline in
the local public state. The default state path is
`packages/contracts/ops/d17-live.json`.

## Execution stages

The fixed defaults fund each new participant with `0.018` Sepolia ETH from
node 1. Transactions have a `2 gwei` maximum fee, `0.1 gwei` priority fee and
12,000,000 gas ceiling. Journaled outgoing value plus gas is limited to
`0.10 ETH` across the run and `0.075 ETH` for node 1. Transfers between these
test wallets count toward these conservative outgoing limits even though
they remain controlled by the operator.

After reviewing preflight, run the stages serially:

```powershell
node scripts/d17-sepolia.cjs --stage fund --role node-1 --execute
if ($LASTEXITCODE -ne 0) { throw 'Funding stage failed' }
1..3 | ForEach-Object {
  node scripts/d17-sepolia.cjs --stage participant --role "participant-$_" --execute
  if ($LASTEXITCODE -ne 0) { throw 'Participant stage failed; inspect public state before continuing' }
}
node scripts/d17-sepolia.cjs --stage researcher --role deployer --execute
if ($LASTEXITCODE -ne 0) { throw 'Researcher stage failed' }
node scripts/d17-sepolia.cjs --stage node-1 --role node-1 --execute
if ($LASTEXITCODE -ne 0) { throw 'Node 1 stage failed' }
node scripts/d17-sepolia.cjs --stage node-2 --role node-2 --execute
if ($LASTEXITCODE -ne 0) { throw 'Node 2 stage failed' }
node scripts/d17-sepolia.cjs --stage settle --role deployer --execute
if ($LASTEXITCODE -ne 0) { throw 'Settlement stage failed' }
```

If settlement reports `D17_PENDING_WINDOW`, wait until the reported block and
rerun the settlement stage. Claim only after settlement has completed:

```powershell
node scripts/d17-sepolia.cjs --stage claim --role deployer --execute
if ($LASTEXITCODE -ne 0) { throw 'Existing participant claim failed' }
1..3 | ForEach-Object {
  node scripts/d17-sepolia.cjs --stage claim --role "participant-$_" --execute
  if ($LASTEXITCODE -ne 0) { throw 'Participant claim failed' }
}
node scripts/d17-sepolia.cjs --stage report --role none
```

The public journal records each signed transaction's hash before broadcast.
An uncertain transaction blocks further writes until its receipt is reconciled;
the runner does not replace it with a newly generated proof or another query.

## Live acceptance

The runner must retain the existing deployment and its configuration. It must
account for pre-existing participants rather than assuming an empty pool.
For the observed one-participant baseline, three new participants should give:

| Measurement | Expected |
| --- | --- |
| Participant count | 4 |
| SNP 0 coverage count | 4 |
| SNP 1 coverage count | 2 |
| New rare-field provider's weighted coverage | 30,000 |
| Each new common-only provider's weighted coverage | 10,000 |
| Full query weighted total | 80,000 |

These weights assume the observed scarcity cap permits a 2x rare-field weight.
Actual payments also include the query's bonus component. Verify each claim
against that complete formula and its token balance delta, then reconcile the
full cohort's payments with the participant pool, allowing only integer-rounding
residuals.

The two existing nodes must have sufficient stake when they approve. Minimum
stake grows with cumulative query fees, so their old D/15 stake is not a fixed
readiness guarantee. Approval and settlement checks must use the specific
query/request pair and the on-chain challenge window.

An interrupted run must reconcile its journal and on-chain receipts before
continuing. Wallet initialization must preserve existing accounts; retries must
not silently create replacement participants or duplicate an uncertain
transaction. A successful local test or proof-only `eth_call` does not mark the
live D/17 acceptance complete.
