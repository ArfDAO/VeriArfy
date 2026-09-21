import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { E19_CLINICAL_POLICY } from "@veriarfy/study";

const panelId = ethers.id(E19_CLINICAL_POLICY.panelId);
const purposeId = ethers.id(E19_CLINICAL_POLICY.purposeId);
const consentVersion = ethers.id(E19_CLINICAL_POLICY.consentVersion);
const panelHash = ethers.id(E19_CLINICAL_POLICY.panelDocumentId);
const documentHash = ethers.id(E19_CLINICAL_POLICY.consentDocumentId);
const MAX_DURATION = BigInt(E19_CLINICAL_POLICY.maximumConsentDays) * 24n * 60n * 60n;

describe("E/19 clinical consent boundary", () => {
  async function fixture() {
    const [owner, participant, researcher, outsider] = await ethers.getSigners();
    const Protocol = await ethers.getContractFactory("ClinicalProtocolHarness");
    const protocol = await Protocol.deploy();
    const Registry = await ethers.getContractFactory("ClinicalRegistryHarness");
    const registry = await Registry.deploy();
    const Clinical = await ethers.getContractFactory("VeriarfyClinical");
    const clinical = await Clinical.deploy(await protocol.getAddress(), await registry.getAddress());
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const policy = { panelId, purposeId, consentVersion, panelHash, consentDocumentHash: documentHash, maxConsentDuration: MAX_DURATION, panelUri: "ipfs://clinical-panel-v1" };
    return { owner, participant, researcher, outsider, protocol, registry, clinical, now, policy };
  }

  it("binds consent to the exact versioned panel, purpose and document", async () => {
    const { participant, protocol, clinical, now, policy } = await fixture();
    await protocol.setParticipant(await participant.getAddress(), true, true);
    await clinical.configurePolicy(policy);
    const expiresAt = now + 30n * 24n * 60n * 60n;

    await expect(clinical.connect(participant).acceptConsent(panelId, purposeId, consentVersion, documentHash, expiresAt))
      .to.emit(clinical, "ClinicalConsentAccepted");
    expect(await clinical.isEligibleContributor(await participant.getAddress())).to.equal(true);
    const consent = await clinical.consentOf(await participant.getAddress());
    expect(consent.expiresAt).to.equal(expiresAt);

    await expect(clinical.configurePolicy({ ...policy, purposeId: ethers.id("different-purpose") }))
      .to.be.revertedWithCustomError(clinical, "PolicyFrozen");
  });

  it("rejects un-enrolled, mismatched, expired and overlong consent", async () => {
    const { participant, clinical, now, policy } = await fixture();
    await clinical.configurePolicy(policy);
    const expiresAt = now + 1n;
    await expect(clinical.connect(participant).acceptConsent(panelId, purposeId, consentVersion, documentHash, expiresAt))
      .to.be.revertedWithCustomError(clinical, "NotEnrolled");

    const { participant: enrolled, protocol, clinical: configured, now: secondNow, policy: secondPolicy } = await fixture();
    await protocol.setParticipant(await enrolled.getAddress(), true, true);
    await configured.configurePolicy(secondPolicy);
    await expect(configured.connect(enrolled).acceptConsent(panelId, purposeId, consentVersion, ethers.id("wrong-document"), secondNow + 1n))
      .to.be.revertedWithCustomError(configured, "ConsentScopeMismatch");
    await time.increase(1);
    const current = BigInt(await time.latest());
    await expect(configured.connect(enrolled).acceptConsent(panelId, purposeId, consentVersion, documentHash, current))
      .to.be.revertedWithCustomError(configured, "InvalidConsentExpiry");
    const overlongNow = BigInt(await time.latest());
    await expect(configured.connect(enrolled).acceptConsent(panelId, purposeId, consentVersion, documentHash, overlongNow + MAX_DURATION + 60n))
      .to.be.revertedWithCustomError(configured, "InvalidConsentExpiry");
  });

  it("revoke stops future eligibility without pretending to erase past aggregates", async () => {
    const { participant, protocol, clinical, now, policy } = await fixture();
    await protocol.setParticipant(await participant.getAddress(), true, true);
    await clinical.configurePolicy(policy);
    await clinical.connect(participant).acceptConsent(panelId, purposeId, consentVersion, documentHash, now + 1_000n);
    await clinical.connect(participant).revokeConsent();
    expect(await clinical.isEligibleContributor(await participant.getAddress())).to.equal(false);
    await expect(clinical.connect(participant).revokeConsent())
      .to.be.revertedWithCustomError(clinical, "ConsentNotActive");
  });

  it("admits only registered researchers for the configured aggregate-only scope", async () => {
    const { researcher, outsider, registry, clinical, policy } = await fixture();
    await clinical.configurePolicy(policy);
    await registry.setRegistered(await researcher.getAddress(), true);

    expect(await clinical.isAuthorizedResearcher(await researcher.getAddress(), panelId, purposeId)).to.equal(true);
    expect(await clinical.isAuthorizedResearcher(await outsider.getAddress(), panelId, purposeId)).to.equal(false);
    await expect(clinical.requireAuthorizedResearcher(await outsider.getAddress(), panelId, purposeId))
      .to.be.revertedWithCustomError(clinical, "ResearcherNotRegistered");
    await expect(clinical.requireAuthorizedResearcher(await researcher.getAddress(), panelId, ethers.id("other-purpose")))
      .to.be.revertedWithCustomError(clinical, "ResearchPurposeMismatch");
  });
});
