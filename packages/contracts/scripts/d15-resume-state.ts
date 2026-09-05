import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAddress, getCreateAddress, keccak256, toUtf8Bytes, ZeroAddress } from "ethers";

import { D15_PROFILE_ID, loadD15Profile, sameAddress } from "./d15-profile";

export type CreatedContract = {
  name: string;
  address: string;
  codeHash: string;
};

export type D15ResumeManifest = {
  profile: typeof D15_PROFILE_ID;
  network: "sepolia";
  chainId: 11155111;
  deployer: string;
  authorizedNodes: [string, string];
  startNonce: 15;
  completedNonces: number[];
  created: Record<string, CreatedContract>;
  resume: {
    stakingNonce: 17;
    stakingAddress: string;
    stakingCreationHash: string;
    stakingTemplateHash: string;
    storageNonce: 22;
    storageAddress: string;
    storageCreationHash: string;
    storageTemplateHash: string;
    metricsHash: string;
    metricsSpecHash: string;
    metricsUri: string;
    snpCount: number;
    rareSnpIndex: number;
    baseStakeWei: string;
    valueThreshold: string;
    challengePeriod: string;
    livenessTimeout: string;
    filecoinGenesis: string;
    deployedAt: string;
    deployedAtBlock: number;
  };
  expected: {
    protocol: {
      threshold: string;
      minParticipants: string;
      accreditedRoot: string;
      panelHash: string;
      panelUri: string;
    };
    registryRoot: string;
  };
};

const HASH = /^0x[0-9a-fA-F]{64}$/;
const CREATED_NONCES = [0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 12];
const CREATED_NAMES: Record<number, string> = {
  0: "Groth16Verifier",
  1: "VeriArfyRegistry",
  2: "AnxietyStudy",
  3: "DataProvenanceVerifier",
  4: "ContingencyStats",
  5: "CoverageBits",
  6: "VeriarfyProtocol",
  9: "StableTestToken",
  10: "VeriarfyPayments",
  11: "BiomarkerStats",
  12: "VeriarfyBiomarkers",
};
const CANONICAL_DEPLOYER = "0x836091aB39884BB57DB4Dd94Ee120286Ad7e4fe0";
const CANONICAL_MANIFEST_DIGEST = "0xe5005f9f40c6c5a68700e8dc9584299cc42390ffb1d28af6807a98c9d4dfc5f5";

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} object olmalidir`);
  }
  return value as Record<string, unknown>;
}

function address(value: unknown, label: string): string {
  try {
    const parsed = getAddress(String(value));
    if (parsed === ZeroAddress) throw new Error("zero address");
    return parsed;
  } catch {
    throw new Error(`${label} adresi gecersiz`);
  }
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new Error(`${label} 32-byte hex olmali`);
  }
  return value.toLowerCase();
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} decimal string olmali`);
  }
  return value;
}

function exactArray(actual: number[], expected: number[], label: string): void {
  if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i])) {
    throw new Error(`${label} beklenen diziyle eslesmiyor`);
  }
}

export function parseD15ResumeManifest(raw: unknown): D15ResumeManifest {
  const value = objectOf(raw, "D15 resume manifest");
  if (value.profile !== D15_PROFILE_ID || value.network !== "sepolia" || value.chainId !== 11155111) {
    throw new Error("D15 resume manifest profile/network/chainId gecersiz");
  }
  const deployer = address(value.deployer, "deployer");
  if (!sameAddress(deployer, CANONICAL_DEPLOYER)) throw new Error("D15 deployer canonical adresle eslesmiyor");
  if (!Array.isArray(value.authorizedNodes) || value.authorizedNodes.length !== 2) {
    throw new Error("authorizedNodes iki adres icermeli");
  }
  const authorizedNodes = value.authorizedNodes.map((node, index) => address(node, `authorizedNodes[${index}]`)) as [
    string,
    string,
  ];
  if (sameAddress(authorizedNodes[0], authorizedNodes[1])) throw new Error("authorizedNodes duplicate olamaz");
  if (value.startNonce !== 15) throw new Error("D15 resume startNonce 15 olmali");

  if (!Array.isArray(value.completedNonces)) throw new Error("completedNonces array olmali");
  const completedNonces = value.completedNonces.map((nonce) => {
    if (typeof nonce !== "number" || !Number.isInteger(nonce) || nonce < 0) {
      throw new Error("completed nonce gecersiz");
    }
    return nonce;
  });
  exactArray(
    completedNonces,
    Array.from({ length: 15 }, (_, i) => i),
    "completedNonces",
  );

  const createdRaw = objectOf(value.created, "created");
  exactArray(
    Object.keys(createdRaw)
      .map(Number)
      .sort((a, b) => a - b),
    CREATED_NONCES,
    "created nonce'lari",
  );
  const created: Record<string, CreatedContract> = {};
  for (const nonce of CREATED_NONCES) {
    const item = objectOf(createdRaw[String(nonce)], `created[${nonce}]`);
    const contract = {
      name: typeof item.name === "string" && item.name ? item.name : "",
      address: address(item.address, `created[${nonce}].address`),
      codeHash: hash(item.codeHash, `created[${nonce}].codeHash`),
    };
    if (!contract.name) throw new Error(`created[${nonce}].name bos olamaz`);
    if (contract.name !== CREATED_NAMES[nonce]) {
      throw new Error(`created[${nonce}].name beklenen kontratla eslesmiyor`);
    }
    const derived = getCreateAddress({ from: deployer, nonce });
    if (!sameAddress(derived, contract.address)) {
      throw new Error(`created[${nonce}] CREATE adresi deployer/nonce ile eslesmiyor`);
    }
    created[String(nonce)] = contract;
  }

  const resumeRaw = objectOf(value.resume, "resume");
  if (resumeRaw.stakingNonce !== 17 || resumeRaw.storageNonce !== 22) {
    throw new Error("resume staking/storage nonce'lari gecersiz");
  }
  const resume = {
    stakingNonce: 17 as const,
    stakingAddress: address(resumeRaw.stakingAddress, "stakingAddress"),
    stakingCreationHash: hash(resumeRaw.stakingCreationHash, "stakingCreationHash"),
    stakingTemplateHash: hash(resumeRaw.stakingTemplateHash, "stakingTemplateHash"),
    storageNonce: 22 as const,
    storageAddress: address(resumeRaw.storageAddress, "storageAddress"),
    storageCreationHash: hash(resumeRaw.storageCreationHash, "storageCreationHash"),
    storageTemplateHash: hash(resumeRaw.storageTemplateHash, "storageTemplateHash"),
    metricsHash: hash(resumeRaw.metricsHash, "metricsHash"),
    metricsSpecHash: hash(resumeRaw.metricsSpecHash, "metricsSpecHash"),
    metricsUri: typeof resumeRaw.metricsUri === "string" ? resumeRaw.metricsUri : "",
    snpCount: resumeRaw.snpCount as number,
    rareSnpIndex: resumeRaw.rareSnpIndex as number,
    baseStakeWei: decimal(resumeRaw.baseStakeWei, "baseStakeWei"),
    valueThreshold: decimal(resumeRaw.valueThreshold, "valueThreshold"),
    challengePeriod: decimal(resumeRaw.challengePeriod, "challengePeriod"),
    livenessTimeout: decimal(resumeRaw.livenessTimeout, "livenessTimeout"),
    filecoinGenesis: decimal(resumeRaw.filecoinGenesis, "filecoinGenesis"),
    deployedAt: typeof resumeRaw.deployedAt === "string" ? resumeRaw.deployedAt : "",
    deployedAtBlock: resumeRaw.deployedAtBlock as number,
  };
  if (!Number.isSafeInteger(resume.snpCount) || resume.snpCount < 1) {
    throw new Error("resume.snpCount gecersiz");
  }
  if (!Number.isSafeInteger(resume.rareSnpIndex) || resume.rareSnpIndex < 0 || resume.rareSnpIndex >= resume.snpCount) {
    throw new Error("resume.rareSnpIndex gecersiz");
  }
  if (
    !resume.metricsUri ||
    !resume.deployedAt ||
    !Number.isSafeInteger(resume.deployedAtBlock) ||
    resume.deployedAtBlock <= 0
  ) {
    throw new Error("resume metadata eksik");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(resume.deployedAt) ||
    Number.isNaN(Date.parse(resume.deployedAt))
  ) {
    throw new Error("resume.deployedAt ISO timestamp olmali");
  }
  if (!sameAddress(getCreateAddress({ from: deployer, nonce: 17 }), resume.stakingAddress)) {
    throw new Error("staking CREATE adresi manifest ile eslesmiyor");
  }
  if (!sameAddress(getCreateAddress({ from: deployer, nonce: 22 }), resume.storageAddress)) {
    throw new Error("storage CREATE adresi manifest ile eslesmiyor");
  }

  const expectedRaw = objectOf(value.expected, "expected");
  const protocolRaw = objectOf(expectedRaw.protocol, "expected.protocol");
  const expected = {
    protocol: {
      threshold: decimal(protocolRaw.threshold, "protocol.threshold"),
      minParticipants: decimal(protocolRaw.minParticipants, "protocol.minParticipants"),
      accreditedRoot: decimal(protocolRaw.accreditedRoot, "protocol.accreditedRoot"),
      panelHash: hash(protocolRaw.panelHash, "protocol.panelHash"),
      panelUri: typeof protocolRaw.panelUri === "string" ? protocolRaw.panelUri : "",
    },
    registryRoot: decimal(expectedRaw.registryRoot, "registryRoot"),
  };
  if (!expected.protocol.panelUri) throw new Error("protocol.panelUri bos olamaz");

  return {
    profile: D15_PROFILE_ID,
    network: "sepolia",
    chainId: 11155111,
    deployer,
    authorizedNodes,
    startNonce: 15,
    completedNonces,
    created,
    resume,
    expected,
  };
}

export function loadD15ResumeManifest(): D15ResumeManifest {
  const path = join(__dirname, "..", "ops", "d15-resume.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (keccak256(toUtf8Bytes(JSON.stringify(raw))).toLowerCase() !== CANONICAL_MANIFEST_DIGEST) {
    throw new Error("D15 resume manifest canonical digest eslesmiyor");
  }
  const manifest = parseD15ResumeManifest(raw);
  const configured = loadD15Profile();
  if (!sameAddress(configured.deployer, manifest.deployer)) {
    throw new Error("D15 resume deployer manifest/profile farkli");
  }
  if (
    !sameAddress(configured.authorizedNodes[0], manifest.authorizedNodes[0]) ||
    !sameAddress(configured.authorizedNodes[1], manifest.authorizedNodes[1])
  ) {
    throw new Error("D15 resume node manifest/profile farkli");
  }
  if (manifest.resume.baseStakeWei !== configured.nodeBaseStakeWei.toString()) {
    throw new Error("D15 resume baseStake manifest/profile farkli");
  }
  return manifest;
}

export function assertResumeNonce(latest: number | bigint, pending: number | bigint, expected: number | bigint): void {
  const expectedBig = BigInt(expected);
  if (BigInt(latest) !== expectedBig || BigInt(pending) !== expectedBig) {
    throw new Error(`D15 resume nonce kilidi bozuldu: latest=${latest}, pending=${pending}, expected=${expected}`);
  }
}

export function assertResumeBoundaryNonce(latest: number | bigint, pending: number | bigint): number {
  assertResumeNonce(latest, pending, latest);
  const boundary = BigInt(latest);
  if (boundary < 15n || boundary > 24n) {
    throw new Error(`D15 resume nonce aralik disi: ${latest}`);
  }
  return Number(boundary);
}

export type D15ResumeBoundaryState = {
  metricsConfigured: boolean;
  queryGatewayConfigured: boolean;
  stakingDeployed: boolean;
  stakingPaymentsConfigured: boolean;
  stakingModuleConfigured: boolean;
  challengeConfigured: boolean;
  livenessConfigured: boolean;
  storageDeployed: boolean;
  storageAttestorConfigured: boolean;
};

export function d15ResumeBoundaryState(boundary: number): D15ResumeBoundaryState {
  if (!Number.isInteger(boundary) || boundary < 15 || boundary > 24) {
    throw new Error(`D15 resume boundary nonce gecersiz: ${boundary}`);
  }
  return {
    metricsConfigured: boundary >= 16,
    queryGatewayConfigured: boundary >= 17,
    stakingDeployed: boundary >= 18,
    stakingPaymentsConfigured: boundary >= 19,
    stakingModuleConfigured: boundary >= 20,
    challengeConfigured: boundary >= 21,
    livenessConfigured: boundary >= 22,
    storageDeployed: boundary >= 23,
    storageAttestorConfigured: boundary >= 24,
  };
}

export type D15ProtocolBaseline = {
  owner: string;
  threshold: bigint;
  minParticipants: bigint;
  authorizedNodeCount: bigint;
  authorizedNodes: boolean[];
  biomarkerModule: string;
  queryGateway: string;
  stakingModule: string;
  challengePeriod: bigint;
  livenessTimeout: bigint;
  snpCount: bigint;
  rareSnpIndex: bigint;
  panelHash: string;
  panelUri: string;
  accreditedRoot: bigint;
};

export type D15BiomarkerBaseline = {
  owner: string;
  protocol: string;
  metricCount: bigint;
  metricsHash: string;
  metricsUri: string;
  panelFrozen: boolean;
};

function requireBigInt(actual: bigint, expected: string, label: string): void {
  if (actual !== BigInt(expected)) throw new Error(`${label} beklenen degerde degil`);
}

function requireAddress(actual: string, expected: string, label: string): void {
  if (!sameAddress(actual, expected)) throw new Error(`${label} beklenen adreste degil`);
}

export function assertD15ResumeBaselineState(
  protocol: D15ProtocolBaseline,
  biomarkers: D15BiomarkerBaseline,
  manifest: D15ResumeManifest,
): void {
  requireAddress(protocol.owner, manifest.deployer, "protocol.owner");
  requireBigInt(protocol.threshold, "2", "protocol.threshold");
  requireBigInt(protocol.minParticipants, "1", "protocol.minParticipants");
  requireBigInt(protocol.authorizedNodeCount, "2", "protocol.authorizedNodeCount");
  if (protocol.authorizedNodes.length !== 2 || protocol.authorizedNodes.some((value) => !value)) {
    throw new Error("protocol authorized node state beklenen degerde degil");
  }
  requireAddress(protocol.biomarkerModule, manifest.created["12"].address, "protocol.biomarkerModule");
  requireAddress(protocol.queryGateway, ZeroAddress, "protocol.queryGateway");
  requireAddress(protocol.stakingModule, ZeroAddress, "protocol.stakingModule");
  requireBigInt(protocol.challengePeriod, "0", "protocol.challengePeriod");
  requireBigInt(protocol.livenessTimeout, "0", "protocol.livenessTimeout");
  requireBigInt(protocol.snpCount, String(manifest.resume.snpCount), "protocol.snpCount");
  requireBigInt(protocol.rareSnpIndex, String(manifest.resume.rareSnpIndex), "protocol.rareSnpIndex");
  if (protocol.panelHash.toLowerCase() !== manifest.expected.protocol.panelHash) {
    throw new Error("protocol.panelHash beklenen degerde degil");
  }
  if (protocol.panelUri !== manifest.expected.protocol.panelUri) {
    throw new Error("protocol.panelUri beklenen degerde degil");
  }
  requireBigInt(protocol.accreditedRoot, manifest.expected.protocol.accreditedRoot, "protocol.accreditedRoot");

  requireAddress(biomarkers.owner, manifest.deployer, "biomarkers.owner");
  requireAddress(biomarkers.protocol, manifest.created["6"].address, "biomarkers.protocol");
  requireBigInt(biomarkers.metricCount, "0", "biomarkers.metricCount");
  if (biomarkers.metricsHash.toLowerCase() !== "0x" + "0".repeat(64)) {
    throw new Error("biomarkers.metricsHash bos baseline olmali");
  }
  if (biomarkers.metricsUri !== "") throw new Error("biomarkers.metricsUri bos baseline olmali");
  if (biomarkers.panelFrozen) throw new Error("biomarkers.panelFrozen false olmali");
}
