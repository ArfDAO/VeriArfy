# E/18 aggregate disclosure policy (synthetic demo)

Status: local synthetic-only gate implemented and targeted tests passing; **not deployed**.
The derived genomics statistics and plaintext-vs-FHE parity demo are still pending.
No real-person genomic data may be released on the strength of this policy. The
numerical thresholds below are demo gates, not an anonymity or membership-privacy
guarantee.

## Release unit

The release unit is one immutable study cohort, its fixed genomic/metric panel, and
one canonical ordered output vector. A SNP result is a complete 2x3 control/case by
dosage (0/1/2) table; BMI uses only the already-defined aggregate sufficient
statistics. No identity, individual record, person graph, arbitrary cohort filter,
or new raw-data category is part of E/18. The synthetic parity fixture is separate
from any real-person deployment.

## Eligibility before granting decryption access

For every selected SNP, the frozen table must contain at least 30 covered controls
and 30 covered cases, and each of its six genotype cells must contain at least five
people. A missing genotype does not count toward that SNP's covered group size.
Whole-table fail-closed refusal is required: suppressing one cell while disclosing
the other cells or row/column totals can reconstruct it. BMI group aggregates also
require 30 covered people per group. The aggregate release must not reveal an
unmasked dosage total or biomarker sufficient statistic when any applicable gate
fails. A failed gate may be signalled as a generic refusal; exact failing counts
must not be disclosed.

The check has to govern the FHE ACL grant (or grant only a cryptographically masked
output). A browser-only check after `FHE.allow` is not a privacy control. The current
`VeriarfyProtocol` checks only global `participantCount` when opening a request and
later grants the frozen raw handles; increasing `minParticipants` on the existing
Sepolia deployment neither supplies group/cell gates nor rechecks old requests at
execution. Existing grants cannot be revoked. Thus the existing deployment is **not**
an E/18 real-data release target.

## A-B / repeat-query control

The first request (eligible or not) consumes the one release slot and fixes the
study cohort and selected panel. Any subsequent request is rejected globally,
including repeats and requests from another researcher address. Reading the first
request again uses its same immutable handles. No partial-panel, overlapping-panel,
or rolling-snapshot variant can be opened on that deployment. Contributions after
the first request may continue but cannot be disclosed there. A new study/deployment
requires separate disclosure review; overlapping real-person studies are not
implicitly safe. The ledger belongs at the protocol/study level, not in browser
storage. The E/18 contract also requires its owner as the query gateway: an encrypted
refusal is not a payable research result, so the existing Payments flow is excluded.

## Required regression evidence

- At least 30+30 global participants but fewer than 30 covered in one group for a
  chosen SNP: refuse before ACL grant.
- A 2x3 table with five people in every cell: eligible; change one cell to four:
  refuse the entire table without exposing complementary totals.
- A query at cohort N followed by an otherwise-identical query at N+1: the second
  must not yield a new decryptable vector; subtraction must be impossible.
- Repeat the same request, change field order/subset/overlap, or switch researcher
  wallet: no new vector that differs by cohort or selected-field composition.
- Raising the threshold after a request is opened must not allow that already-open
  request to bypass the policy at execution.
- A failed FHE gate must be tested by attempting researcher decryption of every raw
  and masked handle, not merely by inspecting what the UI renders.
- Synthetic plaintext and FHE sufficient statistics match exactly; downstream
  floating-point statistics use declared tolerances. This parity test does not
  substitute for any disclosure regression above.

Local synthetic tests exercise actual encrypted table and BMI masking, raw-handle ACL
denial, 30+30 integration, threshold change after request, and N to N+1 refusal.
The E/18 protocol runtime is 24,407 bytes (169 below EIP-170's 24,576-byte cap);
gas/HCU and a broad independent security review remain pending. A future Sepolia
deployment, wallet use, or real-person data release requires its own explicit
authorization and review.
