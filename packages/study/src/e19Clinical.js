/**
 * E/19 farmakogenomik onam politikasi.
 *
 * Bu, klinik karar veya bireysel ilac onerisi degildir. Kimliksiz/sentetik
 * arastirma panelinin insan-okunur kaynak tanimidir; zincirde yalnizca bu
 * alanlarin keccak256 kimlikleri ve belge ozeti taahhut edilir.
 */
export const E19_CLINICAL_POLICY = Object.freeze({
  panelId: "cpic-cyp2c19-clopidogrel-v1",
  purposeId: "research-pharmacogenomic-aggregate-only-v1",
  consentVersion: "veriarfy-clinical-consent-v1",
  consentDocumentId: "veriarfy-clinical-consent-document-v1",
  panelDocumentId: "synthetic-clinical-panel-document-v1",
  panelUri: "https://files.cpicpgx.org/data/guideline/publication/clopidogrel/2022/35034351.pdf",
  maximumConsentDays: 365,
  scope: "Synthetic-only aggregate pharmacogenomic research; no clinical decision support.",
  excludes: Object.freeze([
    "raw clinical or genetic export",
    "person-level results",
    "free cohort filters",
    "insurance, employer, or marketing use",
    "clinical prescribing or treatment decisions",
  ]),
  revocation: "Stops future clinical contribution; immutable past aggregate snapshots cannot be subtracted.",
});

/** Farkli istemcilerin sessizce sinirsiz/gecersiz bir onam gostermesini onler. */
export function validateE19ClinicalPolicy(policy = E19_CLINICAL_POLICY) {
  const required = ["panelId", "purposeId", "consentVersion", "consentDocumentId", "panelDocumentId", "panelUri", "scope", "revocation"];
  for (const key of required) {
    if (typeof policy[key] !== "string" || policy[key].trim() === "") {
      throw new TypeError(`E/19 policy ${key} zorunludur`);
    }
  }
  if (!Number.isInteger(policy.maximumConsentDays) || policy.maximumConsentDays < 1 || policy.maximumConsentDays > 365) {
    throw new RangeError("E/19 policy maximumConsentDays 1..365 olmalidir");
  }
  if (!Array.isArray(policy.excludes) || policy.excludes.length === 0) {
    throw new TypeError("E/19 policy exclusions zorunludur");
  }
  return policy;
}
