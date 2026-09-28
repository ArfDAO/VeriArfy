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

## Completed Sepolia run — 2026-09-10

Acceptance passed at block **11,676,464**. Three new independent participant
wallets joined the existing participant, giving four participants and coverage
counts `[4, 2]`. Each new wallet submitted a real provenance proof, encrypted
enrollment, all ten encrypted SNP contributions, and a KMS-backed rarity result.
All three valid proofs passed and altered public signals were rejected.

Query **1**, disclosure request **1**, received both node approvals and completed
the challenge window. [Settlement transaction](https://sepolia.etherscan.io/tx/0x541942a3ebd0322bc72d4e0c9deda4b2276778f2aba8c23500a95b86ce14f225)
confirmed at block 11,676,452. All four claims were confirmed and checked against
their events, historical claimable amounts, and token balances immediately
before and at the receipt block.

| Participant | Weighted coverage | Bonus weight | Paid tUSD |
| --- | ---: | ---: | ---: |
| Existing deployer participant | 30,000 | 15,000 | 0.357135 |
| New participant 1: both fields, rare carrier | 30,000 | 34,828 | 0.440592 |
| New participant 2: common field only | 10,000 | 15,000 | 0.161135 |
| New participant 3: common field only | 10,000 | 15,000 | 0.161135 |

The rare field had a 2x scarcity weight. Participant 1's 3x total coverage weight
relative to a common-only participant is distinct from the separate rarity and
founding bonus. In raw token units, each payout equals
`floor(784000 * weightedCoverage / 80000) + floor(336000 * bonusWeight / 79828)`.
The 1.4 tUSD query fee funded a 1.12 tUSD participant pool and 0.28 tUSD treasury
share. Claims totaled **1.119997 tUSD**, leaving **0.000003 tUSD** rounding dust.

The run confirmed **35 transactions**. Gas cost was
**0.034556918271685388 Sepolia ETH**. Funding transferred 0.054 ETH between our
test wallets, and node stake top-ups added 0.0036146 ETH. Conservative outgoing
accounting totaled 0.092171518271685388 ETH, below the 0.10 ETH cap. No faucet
was needed. Keys remain in isolated local custody; only public evidence is in
[`d17-live.json`](../packages/contracts/ops/d17-live.json).

Settlement increased the dynamic minimum stake to 0.0035849 ETH. Each node has
0.0028073 ETH staked and would need another **0.0007776 ETH** before approving a
future query. Both had sufficient stake for this completed query.

Local validation included three economic scenarios (3, 5, and 3-new-plus-1-existing
participants), 57 Coverage/Payments tests, signing and recovery guards, launcher
tests, and ABI synchronization checks. Live execution additionally exposed and
fixed decimal commitment serialization and stale `latest` RPC balance reads;
the final report uses receipt-block balance evidence.

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
