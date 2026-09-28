/**
 * E/18 FHE/plaintext parity kaniti.
 *
 * `FHE_RELEASED_SNAPSHOT`, E18DisclosurePolicy.test.ts tarafinda gercek FHE
 * handle'larindan cozulup dogrulanan sentetik aggregate transcript'idir.
 * Burada ham kisi verisi veya decrypt edilebilir handle yoktur. Sabit tutulur
 * ki plaintext ureticisiyle ayni hata kaynagini paylasmasin.
 */
import {
  E18_SYNTHETIC_FIXTURE_ID,
  E18_SYNTHETIC_PARTICIPANTS,
  e18PlaintextReference,
  makeE18SyntheticCohort,
} from "./e18Synthetic.js";
import { compareGroups, summarizeGenomicTable } from "./stats.js";

function freezeAggregate(aggregate) {
  return Object.freeze({ ...aggregate });
}

export const E18_FHE_RELEASED_SNAPSHOT = Object.freeze({
  fixtureId: E18_SYNTHETIC_FIXTURE_ID,
  participantCount: E18_SYNTHETIC_PARTICIPANTS,
  contingency: Object.freeze([
    Object.freeze([15, 10, 5]),
    Object.freeze([5, 10, 15]),
  ]),
  bmi: Object.freeze([
    freezeAggregate({ n: 30, sum: 72_000, sumSq: 173_024_750 }),
    freezeAggregate({ n: 30, sum: 90_000, sumSq: 270_224_750 }),
  ]),
  evidence: Object.freeze({
    test: "packages/contracts/test/E18DisclosurePolicy.test.ts",
    assertion: "FHE safe handles decrypt to this transcript; raw handles reject decryption.",
    scope: "Deterministic synthetic fixture; not a live Sepolia cohort disclosure.",
  }),
});

function delta(left, right) {
  return Number(left) - Number(right);
}

function aggregateDelta(plaintext, fhe) {
  return {
    n: delta(fhe.n, plaintext.n),
    sum: delta(fhe.sum, plaintext.sum),
    sumSq: delta(fhe.sumSq, plaintext.sumSq),
  };
}

function allZero(value) {
  return Object.values(value).every((item) => item === 0);
}

/** Plaintext referansini immutable FHE transcript'iyle karsilastirir. */
export function buildE18ParityReport() {
  const plaintext = e18PlaintextReference(makeE18SyntheticCohort());
  const fhe = E18_FHE_RELEASED_SNAPSHOT;
  const snpDelta = plaintext.contingency.map((row, group) =>
    row.map((count, dosage) => delta(fhe.contingency[group][dosage], count)),
  );
  const bmiDelta = plaintext.bmi.map((aggregate, group) => aggregateDelta(aggregate, fhe.bmi[group]));
  const checks = {
    fixtureId: fhe.fixtureId === E18_SYNTHETIC_FIXTURE_ID,
    participants: plaintext.participantCount === fhe.participantCount,
    snp: snpDelta.every((row) => row.every((value) => value === 0)),
    bmi: bmiDelta.every(allZero),
  };

  return Object.freeze({
    fixtureId: E18_SYNTHETIC_FIXTURE_ID,
    plaintext,
    fhe,
    delta: Object.freeze({ snp: Object.freeze(snpDelta.map((row) => Object.freeze(row))), bmi: Object.freeze(bmiDelta.map(freezeAggregate)) }),
    checks: Object.freeze(checks),
    pass: Object.values(checks).every(Boolean),
    genomic: summarizeGenomicTable(plaintext.contingency),
    bmi: compareGroups(plaintext.bmi[0], plaintext.bmi[1]),
  });
}
