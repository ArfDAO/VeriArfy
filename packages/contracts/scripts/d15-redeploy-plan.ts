import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { artifacts, ethers } from "hardhat";
import { loadD15Profile, sameAddress } from "./d15-profile";
import { loadD15ResumeManifest } from "./d15-resume-state";
import { loadStudyConfig } from "./study-config";
import { patchImmutableReferences } from "./d15-artifacts";

export const CONTRACTS_DIR = join(__dirname, "..");
export const REVIEW_PATH = join(CONTRACTS_DIR, "ops", "d15-redeploy-review.json");
export const JOURNAL_PATH = join(CONTRACTS_DIR, "ops", "d15-redeploy-journal.json");
export const PREVIOUS_PATH = join(CONTRACTS_DIR, "ops", "d15-previous-deployment.json");
export const START_NONCE = 24;

export type RedeployStep = {
  nonce: number;
  label: string;
  to: string | null;
  data: string;
  value: string;
  gasLimit: string;
  contractName?: string;
  address?: string;
  runtimeHash?: string;
};
export type RedeployPlan = {
  version: 1;
  chainId: number;
  deployer: string;
  startNonce: number;
  endNonce: number;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  maxCostWei: string;
  previousHash: string;
  keyLockHash: string;
  contracts: Record<string, string>;
  reused: Record<string, { address: string; runtimeHash: string }>;
  steps: RedeployStep[];
};

export function readPreviousDeployment(): any {
  const prior = JSON.parse(readFileSync(PREVIOUS_PATH, "utf8"));
  assertPreviousDeployment(prior);
  return prior;
}

export function assertPreviousDeployment(prior: any): void {
  const baseline = loadD15ResumeManifest();
  if (prior?.network !== baseline.network || prior.chainId !== baseline.chainId ||
      !sameAddress(prior.deployer, baseline.deployer) ||
      JSON.stringify(prior.authorizedNodes) !== JSON.stringify(baseline.authorizedNodes) ||
      prior.initialRoot !== baseline.expected.registryRoot || prior.accreditedRoot !== baseline.expected.protocol.accreditedRoot ||
      prior.paymentTokenIsTestToken !== true || prior.liquidityShareBps !== 8000 ||
      prior.deployedAt !== baseline.resume.deployedAt || prior.deployedAtBlock !== baseline.resume.deployedAtBlock) {
    throw new Error("previous deployment differs from canonical D15 baseline");
  }
  const expected: Record<string, string> = {
    VeriarfyStorage: baseline.resume.storageAddress, VeriarfyStaking: baseline.resume.stakingAddress,
  };
  for (const item of Object.values(baseline.created)) {
    if (["ContingencyStats", "CoverageBits", "BiomarkerStats"].includes(item.name)) continue;
    expected[item.name === "StableTestToken" ? "PaymentToken" : item.name] = item.address;
  }
  if (Object.keys(prior.contracts ?? {}).length !== Object.keys(expected).length) throw new Error("previous contract set mismatch");
  for (const [name, address] of Object.entries(expected)) {
    if (!sameAddress(prior.contracts[name], address)) throw new Error(`previous ${name} differs from canonical D15 baseline`);
  }
}

function jsonFileHash(path: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(JSON.parse(readFileSync(path, "utf8")))));
}

export function assertPinnedProofArtifacts(): void {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(systemroot|windir|temp|tmp|path)$/i.test(key)) env[key] = value;
  }
  execFileSync(process.execPath, [
    "--max-old-space-size=512",
    join(CONTRACTS_DIR, "..", "circuits", "scripts", "check-artifacts.mjs"),
  ], { env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024, stdio: "pipe" });
}

export function linkBytecode(
  bytecode: string, references: any, libraries: Record<string, string>,
): string {
  let hex = bytecode.replace(/^0x/, "");
  for (const source of Object.values(references ?? {}) as any[]) {
    for (const [name, entries] of Object.entries(source) as [string, any[]][]) {
      if (!libraries[name]) throw new Error(`missing pinned library ${name}`);
      const address = ethers.getAddress(libraries[name]).slice(2).toLowerCase();
      for (const entry of entries) {
        if (entry.length !== 20) throw new Error(`invalid library reference ${name}`);
        const start = entry.start * 2;
        hex = hex.slice(0, start) + address + hex.slice(start + 40);
      }
    }
  }
  if (!/^[a-fA-F0-9]+$/.test(hex)) throw new Error("unresolved artifact links");
  return `0x${hex}`;
}

export async function expectedRuntime(
  name: string, libraries: Record<string, string>, immutableValues: Record<string, string | bigint>,
): Promise<string> {
  const artifact = await artifacts.readArtifact(name);
  const info = await artifacts.getBuildInfo(`${artifact.sourceName}:${name}`);
  if (!info) throw new Error(`${name} build-info missing; compile first`);
  const compiled = info.input.sources[artifact.sourceName]?.content;
  const source = readFileSync(join(CONTRACTS_DIR, artifact.sourceName), "utf8");
  if (compiled?.replace(/\r\n/g, "\n") !== source.replace(/\r\n/g, "\n")) {
    throw new Error(`${name} source/artifact mismatch; compile first`);
  }
  const output = info.output.contracts[artifact.sourceName][name].evm.deployedBytecode;
  const names: Record<string, string> = {};
  function visit(node: any): void {
    if (!node || typeof node !== "object") return;
    if (node.nodeType === "VariableDeclaration" && node.mutability === "immutable") {
      names[String(node.id)] = node.name;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  for (const entry of Object.values(info.output.sources)) visit(entry.ast);
  const values: Record<string, string | bigint> = {};
  for (const id of Object.keys(output.immutableReferences ?? {})) {
    if (immutableValues[names[id]] === undefined) throw new Error(`${name} immutable ${names[id]} missing`);
    values[id] = immutableValues[names[id]];
  }
  const linked = linkBytecode(output.object, output.linkReferences, libraries).slice(2);
  return patchImmutableReferences(linked, output.immutableReferences ?? {}, values);
}

export function reviewOf(plan: RedeployPlan): any {
  return {
    ...plan,
    steps: plan.steps.map(({ data, ...step }) => ({ ...step, dataHash: ethers.keccak256(data) })),
  };
}

export function hashPlan(plan: RedeployPlan): string {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(reviewOf(plan))));
}

/** Pure transaction construction: no signer, RPC, or output writes. */
export async function buildRedeployPlan(): Promise<RedeployPlan> {
  assertPinnedProofArtifacts();
  const profile = loadD15Profile();
  const prior = readPreviousDeployment();
  const baseline = loadD15ResumeManifest();
  const study = loadStudyConfig(join(CONTRACTS_DIR, "study", "deploy-env.json"), {
    requireMetrics: true, environment: {},
  });
  if (study.metricsSpecHash !== baseline.resume.metricsSpecHash ||
      study.env.PANEL_HASH !== baseline.expected.protocol.panelHash ||
      study.env.METRICS_HASH !== baseline.resume.metricsHash) {
    throw new Error("redeploy study differs from pinned D15 study");
  }
  const reused: RedeployPlan["reused"] = {};
  for (const nonce of [4, 5, 9, 11]) {
    const item = baseline.created[String(nonce)];
    reused[item.name] = { address: item.address, runtimeHash: item.codeHash };
  }
  reused.VeriarfyStorage = {
    address: prior.contracts.VeriarfyStorage,
    runtimeHash: "0x29a1c25e9ab0559fea8623d10cbae3d7b8a35af62cf9f0bf091d09bb032eadd5",
  };
  const libraries = Object.fromEntries(
    ["ContingencyStats", "CoverageBits", "BiomarkerStats"].map(name => [name, reused[name].address]),
  );
  const contracts: Record<string, string> = {
    PaymentToken: reused.StableTestToken.address, VeriarfyStorage: reused.VeriarfyStorage.address,
  };
  const steps: RedeployStep[] = [];
  async function create(name: string, args: any[], gasLimit: number, immutables: Record<string, string | bigint> = {}) {
    const nonce = START_NONCE + steps.length;
    const address = ethers.getCreateAddress({ from: profile.deployer, nonce });
    const artifact = await artifacts.readArtifact(name);
    const factory = new ethers.ContractFactory(artifact.abi, linkBytecode(artifact.bytecode, artifact.linkReferences, libraries));
    const tx = await factory.getDeployTransaction(...args);
    const runtimeHash = ethers.keccak256(await expectedRuntime(name, libraries, immutables));
    steps.push({ nonce, label: `deploy ${name}`, to: null, data: String(tx.data), value: "0", gasLimit: String(gasLimit), contractName: name, address, runtimeHash });
    contracts[name] = address;
  }
  async function call(name: string, method: string, args: any[], gasLimit = 150_000) {
    const artifact = await artifacts.readArtifact(name);
    steps.push({ nonce: START_NONCE + steps.length, label: `${name}.${method}`, to: contracts[name],
      data: new ethers.Interface(artifact.abi).encodeFunctionData(method, args), value: "0", gasLimit: String(gasLimit) });
  }
  await create("Groth16Verifier", [], 1_200_000);
  await create("VeriArfyRegistry", [contracts.Groth16Verifier, prior.initialRoot], 1_200_000, { verifier: contracts.Groth16Verifier });
  await create("AnxietyStudy", [contracts.VeriArfyRegistry], 2_500_000, { registry: contracts.VeriArfyRegistry });
  await create("DataProvenanceVerifier", [], 1_800_000);
  await create("VeriarfyProtocol", [profile.deployer, 2, 1, contracts.DataProvenanceVerifier, prior.accreditedRoot], 6_000_000,
    { provenanceVerifier: contracts.DataProvenanceVerifier });
  for (const node of profile.authorizedNodes) await call("VeriarfyProtocol", "authorizeNode", [node]);
  await create("VeriarfyPayments", [profile.deployer, contracts.PaymentToken, contracts.VeriarfyProtocol, contracts.VeriArfyRegistry, 8000, 1000000, 50000], 4_500_000,
    { token: contracts.PaymentToken, protocol: contracts.VeriarfyProtocol, researchers: contracts.VeriArfyRegistry, liquidityShareBps: 8000n });
  await create("VeriarfyBiomarkers", [contracts.VeriarfyProtocol], 5_000_000, { protocol: contracts.VeriarfyProtocol });
  await call("VeriarfyProtocol", "setBiomarkerModule", [contracts.VeriarfyBiomarkers]);
  await call("VeriarfyProtocol", "configurePanel", [10, 0, study.env.PANEL_HASH, study.env.PANEL_URI], 500_000);
  await call("VeriarfyBiomarkers", "configureMetrics", [study.metrics, study.env.METRICS_HASH, study.env.METRICS_URI], 800_000);
  await call("VeriarfyProtocol", "setQueryGateway", [contracts.VeriarfyPayments]);
  await create("VeriarfyStaking", [profile.deployer, contracts.VeriarfyProtocol, profile.nodeBaseStakeWei, 250000], 2_500_000, { protocol: contracts.VeriarfyProtocol });
  await call("VeriarfyStaking", "setPayments", [contracts.VeriarfyPayments]);
  await call("VeriarfyProtocol", "setStakingModule", [contracts.VeriarfyStaking]);
  await call("VeriarfyProtocol", "setChallengePeriod", [20]);
  await call("VeriarfyProtocol", "setLivenessTimeout", [7200]);
  const maxFeePerGas = "2000000000";
  return {
    version: 1, chainId: profile.chainId, deployer: profile.deployer, startNonce: START_NONCE,
    endNonce: START_NONCE + steps.length, maxFeePerGas, maxPriorityFeePerGas: "100000000",
    maxCostWei: String(steps.reduce((sum, step) => sum + BigInt(step.gasLimit), 0n) * BigInt(maxFeePerGas)),
    previousHash: jsonFileHash(PREVIOUS_PATH),
    keyLockHash: jsonFileHash(join(CONTRACTS_DIR, "..", "circuits", "artifacts.lock.json")),
    contracts, reused, steps,
  };
}

export function transactionFor(plan: RedeployPlan, step: RedeployStep): any {
  return { type: 2, chainId: plan.chainId, nonce: step.nonce, to: step.to, data: step.data,
    value: BigInt(step.value), gasLimit: BigInt(step.gasLimit), maxFeePerGas: BigInt(plan.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(plan.maxPriorityFeePerGas) };
}

export function assertTransaction(plan: RedeployPlan, step: RedeployStep, tx: any): void {
  const expected = transactionFor(plan, step);
  if (!tx || ethers.getAddress(tx.from) !== plan.deployer || tx.nonce !== step.nonce ||
      (tx.to?.toLowerCase() ?? null) !== (step.to?.toLowerCase() ?? null) || tx.data !== step.data ||
      Number(tx.chainId) !== plan.chainId || tx.type !== 2) throw new Error(`nonce ${step.nonce} transaction differs from plan`);
  for (const field of ["value", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas"]) {
    if (BigInt(tx[field] ?? -1) !== expected[field]) throw new Error(`nonce ${step.nonce} ${field} differs from plan`);
  }
}
