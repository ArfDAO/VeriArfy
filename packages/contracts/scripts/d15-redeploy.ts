import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { artifacts, ethers, network } from "hardhat";
import { fullProveIsolated } from "./isolated-proof";
import {
  assertTransaction,
  buildRedeployPlan,
  CONTRACTS_DIR,
  hashPlan,
  JOURNAL_PATH,
  readPreviousDeployment,
  PREVIOUS_PATH,
  RedeployPlan,
  REVIEW_PATH,
  reviewOf,
  START_NONCE,
  transactionFor,
} from "./d15-redeploy-plan";
import { loadD15Profile, sameAddress } from "./d15-profile";
import { loadD15ResumeManifest } from "./d15-resume-state";
import { publishD15OutputPair } from "./d15-output";
import { loadStudyConfig } from "./study-config";

export type JournalEntry = { nonce: number; hash: string };
export type RedeployJournal = { planHash: string; entries: JournalEntry[] };
export type RedeployReceipt = { nonce: number; hash: string; blockNumber: number };

const END_NONCE = 42;
const ZERO_CODE = "0x";
const DEPLOYMENT_PATH = join(__dirname, "..", "deployments", "sepolia.json");
const WEB_DEPLOYMENT_PATH = join(__dirname, "..", "..", "web", "src", "config", "deployment.json");

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function parseJournal(raw: unknown): RedeployJournal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("D15 redeploy journal object olmali");
  const value = raw as { planHash?: unknown; entries?: unknown };
  if (!isHash(value.planHash) || !Array.isArray(value.entries)) throw new Error("D15 journal planHash/entries gecersiz");
  const entries = value.entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`D15 journal entry ${index} gecersiz`);
    const item = entry as { nonce?: unknown; hash?: unknown };
    if (!Number.isInteger(item.nonce) || Number(item.nonce) !== START_NONCE + index || Number(item.nonce) >= END_NONCE || !isHash(item.hash)) {
      throw new Error(`D15 journal entry ${index} nonce/hash gecersiz`);
    }
    return { nonce: Number(item.nonce), hash: item.hash.toLowerCase() };
  });
  const seen = new Set<number>();
  for (const entry of entries) {
    if (seen.has(entry.nonce)) throw new Error(`D15 journal nonce duplicate: ${entry.nonce}`);
    seen.add(entry.nonce);
  }
  return { planHash: value.planHash.toLowerCase(), entries };
}

export function readJournal(path = JOURNAL_PATH): RedeployJournal | null {
  if (!existsSync(path)) return null;
  return parseJournal(JSON.parse(readFileSync(path, "utf8")));
}

/** Journal never contains raw transactions, signatures, or private keys. */
export function writeJournalAtomic(journal: RedeployJournal, path = JOURNAL_PATH): void {
  const parsed = parseJournal(journal);
  const temp = `${path}.tmp`;
  if (existsSync(temp)) throw new Error(`D15 journal temp dosyasi mevcut: ${temp}`);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(temp, "wx");
  try {
    writeFileSync(fd, `${JSON.stringify(parsed, null, 2)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* preserve original failure */ }
    throw error;
  }
}

export async function writeJournalAtomicAsync(journal: RedeployJournal, path = JOURNAL_PATH): Promise<void> {
  writeJournalAtomic(journal, path);
}

export function expectedReview(plan: RedeployPlan): Record<string, unknown> {
  return { planHash: hashPlan(plan), ...reviewOf(plan) };
}

export function readAndAssertReview(plan: RedeployPlan, path = REVIEW_PATH): Record<string, unknown> {
  if (!existsSync(path)) throw new Error(`D15 redeploy review missing: ${path}`);
  const actual = JSON.parse(readFileSync(path, "utf8"));
  const expected = expectedReview(plan);
  if (!jsonEqual(actual, expected)) throw new Error("D15 redeploy review plan ile birebir eslesmiyor");
  return actual;
}

function asBigInt(value: unknown, label: string): bigint {
  try { return BigInt(value as string | number | bigint); } catch { throw new Error(`${label} bigint okunamadi`); }
}

function statusOK(receipt: any): boolean {
  return receipt?.status === 1 || receipt?.status === 1n || receipt?.status === "1";
}

async function assertReusedCode(plan: RedeployPlan, provider: any): Promise<void> {
  for (const [name, item] of Object.entries(plan.reused)) {
    const code = await provider.getCode(item.address);
    if (code === ZERO_CODE) throw new Error(`reused ${name} code missing at ${item.address}`);
    if (ethers.keccak256(code).toLowerCase() !== item.runtimeHash.toLowerCase()) {
      throw new Error(`reused ${name} runtime hash mismatch`);
    }
  }
}

async function assertNoUnexpectedCreateCode(plan: RedeployPlan, provider: any, completed: Set<number>): Promise<void> {
  for (const step of plan.steps) {
    if (!step.address) continue;
    const code = await provider.getCode(step.address);
    if (completed.has(step.nonce)) {
      if (code === ZERO_CODE || !step.runtimeHash || ethers.keccak256(code).toLowerCase() !== step.runtimeHash.toLowerCase()) {
        throw new Error(`nonce ${step.nonce} deployed code/runtime mismatch`);
      }
    } else if (code !== ZERO_CODE) {
      throw new Error(`future CREATE address already contains code: nonce ${step.nonce} ${step.address}`);
    }
  }
}

async function assertFeeAndBalance(plan: RedeployPlan, provider: any, remaining: bigint): Promise<void> {
  if (remaining === 0n) return;
  const balance = asBigInt(await provider.getBalance(plan.deployer), "deployer balance");
  const block = await provider.getBlock("latest");
  if (block?.baseFeePerGas === null || block?.baseFeePerGas === undefined) throw new Error("EIP-1559 base fee unavailable");
  const baseFee = asBigInt(block.baseFeePerGas, "base fee");
  if (baseFee > BigInt(plan.maxFeePerGas)) throw new Error(`base fee cap exceeded: ${baseFee}`);
  if (balance < remaining) throw new Error(`deployer balance below remaining max cost: ${balance} < ${remaining}`);
}

async function assertProfileChain(plan: RedeployPlan, provider: any): Promise<void> {
  const profile = loadD15Profile();
  const chain = await provider.getNetwork();
  if (Number(chain.chainId) !== profile.chainId || Number(chain.chainId) !== plan.chainId || network.name !== profile.network) {
    throw new Error("D15 redeploy chain/profile mismatch");
  }
  if (!sameAddress(profile.deployer, plan.deployer)) throw new Error("D15 redeploy deployer/profile mismatch");
}

async function call(contract: any, method: string, label: string): Promise<any> {
  if (typeof contract[method] !== "function") throw new Error(`${label} getter missing: ${method}`);
  return contract[method]();
}

async function artifactContract(name: string, address: string, provider: any): Promise<any> {
  const artifact = await artifacts.readArtifact(name);
  return new ethers.Contract(address, artifact.abi, provider);
}

export async function assertInitialState(plan: RedeployPlan, provider: any): Promise<void> {
  const token = new ethers.Contract(plan.reused.StableTestToken.address, [
    "function owner() view returns (address)", "function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)",
  ], provider);
  if (!sameAddress(await call(token, "owner", "token"), plan.deployer)) throw new Error("token owner mismatch");
  if (asBigInt(await call(token, "totalSupply", "token"), "totalSupply") !== 0n) throw new Error("token totalSupply must be zero");
  if (asBigInt(await call(token, "decimals", "token"), "decimals") !== 6n) throw new Error("token decimals must be 6");

  const storage = new ethers.Contract(plan.reused.VeriarfyStorage.address, [
    "function owner() view returns (address)", "function attestor() view returns (address)",
    "function trackedCidCount() view returns (uint256)", "function filecoinGenesis() view returns (uint64)",
  ], provider);
  if (!sameAddress(await call(storage, "owner", "storage"), plan.deployer)) throw new Error("storage owner mismatch");
  if (!sameAddress(await call(storage, "attestor", "storage"), plan.deployer)) throw new Error("storage attestor mismatch");
  if (asBigInt(await call(storage, "trackedCidCount", "storage"), "trackedCidCount") !== 0n) throw new Error("trackedCidCount must be zero");
  if (asBigInt(await call(storage, "filecoinGenesis", "storage"), "filecoinGenesis") !== 1598306400n) throw new Error("filecoin genesis mismatch");
}

type Progress = { journal: RedeployJournal | null; completed: Set<number>; pending: Set<number>; receipts: RedeployReceipt[]; latest: number; pendingNonce: number };

export async function inspectProgress(plan: RedeployPlan, provider: any, journalPath = JOURNAL_PATH): Promise<Progress> {
  const journal = readJournal(journalPath);
  if (journal && journal.planHash !== hashPlan(plan).toLowerCase()) throw new Error("D15 journal planHash mismatch");
  const entries = new Map((journal?.entries ?? []).map((entry) => [entry.nonce, entry]));
  const byNonce = new Map(plan.steps.map((step) => [step.nonce, step]));
  for (const nonce of entries.keys()) if (!byNonce.has(nonce)) throw new Error(`D15 journal unexpected nonce ${nonce}`);
  const latest = Number(await provider.getTransactionCount(plan.deployer, "latest"));
  const pendingNonce = Number(await provider.getTransactionCount(plan.deployer, "pending"));
  if (!Number.isSafeInteger(latest) || latest < plan.startNonce || !Number.isSafeInteger(pendingNonce)) {
    throw new Error("D15 nonce before plan start or invalid");
  }
  if (pendingNonce < latest) throw new Error(`D15 nonce regression latest=${latest} pending=${pendingNonce}`);
  if (pendingNonce > latest + 1) throw new Error("D15 supports only one in-flight transaction");
  const completed = new Set<number>();
  const pending = new Set<number>();
  const receipts: RedeployReceipt[] = [];
  for (const [nonce, entry] of entries) {
    const step = byNonce.get(nonce)!;
    const tx = await provider.getTransaction(entry.hash);
    const receipt = await provider.getTransactionReceipt(entry.hash);
    if (tx) {
      if (tx.hash?.toLowerCase() !== entry.hash) throw new Error(`nonce ${nonce} transaction hash mismatch`);
      assertTransaction(plan, step, tx);
    }
    if (receipt) {
      if (!tx) throw new Error(`nonce ${nonce} receipt exists without verifiable transaction`);
      if (!statusOK(receipt)) throw new Error(`nonce ${nonce} transaction reverted`);
      if ((receipt.hash ?? receipt.transactionHash)?.toLowerCase() !== entry.hash ||
          !Number.isSafeInteger(Number(receipt.blockNumber)) || Number(receipt.blockNumber) < 1 || nonce >= latest) {
        throw new Error(`nonce ${nonce} receipt hash/block/frontier mismatch`);
      }
      if (step.address && (!receipt.contractAddress || !sameAddress(receipt.contractAddress, step.address))) {
        throw new Error(`nonce ${nonce} receipt CREATE address mismatch`);
      }
      completed.add(nonce);
      receipts.push({ nonce, hash: entry.hash, blockNumber: Number(receipt.blockNumber) });
    } else if (tx) {
      if (nonce !== latest) throw new Error(`nonce ${nonce} pending transaction is not at frontier`);
      pending.add(nonce);
    } else if (latest > nonce) {
      throw new Error(`nonce ${nonce} consumed without verified receipt`);
    }
  }
  if (journal && journal.entries.length > completed.size + 1) throw new Error("D15 journal contains unverified future entries");
  for (let nonce = latest; nonce < pendingNonce; nonce++) {
    const entry = entries.get(nonce);
    if (!entry || (!pending.has(nonce) && !completed.has(nonce))) throw new Error(`unexpected pending nonce ${nonce}`);
  }
  for (let nonce = START_NONCE; nonce < Math.min(latest, plan.endNonce); nonce++) {
    if (!completed.has(nonce)) throw new Error(`nonce ${nonce} skipped without verified receipt`);
  }
  if (latest > plan.endNonce || pendingNonce > plan.endNonce) throw new Error("D15 nonce beyond plan boundary");
  return { journal, completed, pending, receipts, latest, pendingNonce };
}

export async function assertPreflight(plan: RedeployPlan, provider: any, progress?: Progress): Promise<Progress> {
  await assertProfileChain(plan, provider);
  const current = progress ?? await inspectProgress(plan, provider);
  await assertReusedCode(plan, provider);
  await assertNoUnexpectedCreateCode(plan, provider, current.completed);
  await assertInitialState(plan, provider);
  const remaining = plan.steps.filter((step) => !current.completed.has(step.nonce))
    .reduce((sum, step) => sum + BigInt(step.gasLimit) * BigInt(plan.maxFeePerGas), 0n);
  await assertFeeAndBalance(plan, provider, remaining);
  return current;
}

export async function verifyFinalState(plan: RedeployPlan, provider: any): Promise<void> {
  await assertInitialState(plan, provider);
  const protocol: any = await artifactContract("VeriarfyProtocol", plan.contracts.VeriarfyProtocol, provider);
  const profile = loadD15Profile();
  if (!sameAddress(await call(protocol, "owner", "protocol"), plan.deployer)) throw new Error("protocol owner mismatch");
  for (const [method, expected] of [["disclosureThreshold", 2n], ["minParticipants", 1n], ["authorizedNodeCount", 2n], ["challengePeriod", 20n], ["livenessTimeout", 7200n], ["snpCount", 10n], ["rareSnpIndex", 0n], ["participantCount", 0n], ["recordCount", 0n]] as const) {
    if (asBigInt(await call(protocol, method, `protocol.${method}`), method) !== expected) throw new Error(`protocol ${method} mismatch`);
  }
  for (const node of profile.authorizedNodes) if (!(await protocol.isAuthorizedNode(node))) throw new Error(`node not authorized: ${node}`);
  for (const [method, expected] of [["biomarkerModule", plan.contracts.VeriarfyBiomarkers], ["queryGateway", plan.contracts.VeriarfyPayments], ["stakingModule", plan.contracts.VeriarfyStaking]] as const) {
    if (!sameAddress(await call(protocol, method, `protocol.${method}`), expected)) throw new Error(`protocol ${method} mismatch`);
  }
  const baseline = loadD15ResumeManifest();
  if ((await protocol.panelHash()).toLowerCase() !== baseline.expected.protocol.panelHash.toLowerCase()) throw new Error("protocol panelHash mismatch");
  if (await protocol.panelUri() !== baseline.expected.protocol.panelUri) throw new Error("protocol panelUri mismatch");
  if (asBigInt(await protocol.accreditedRoot(), "accreditedRoot") !== BigInt(baseline.expected.protocol.accreditedRoot)) throw new Error("protocol accreditedRoot mismatch");
  if (await protocol.failoverDeclared()) throw new Error("protocol failover must be false");

  const biomarkers: any = await artifactContract("VeriarfyBiomarkers", plan.contracts.VeriarfyBiomarkers, provider);
  if (!sameAddress(await biomarkers.owner(), plan.deployer) || !sameAddress(await biomarkers.protocol(), plan.contracts.VeriarfyProtocol)) throw new Error("biomarker topology mismatch");
  const studyConfig = loadStudyConfig(join(CONTRACTS_DIR, "study", "deploy-env.json"), { requireMetrics: true, environment: {} });
  if (studyConfig.metrics?.length !== 6 || studyConfig.metricsSpecHash?.toLowerCase() !== baseline.resume.metricsSpecHash.toLowerCase() || String(studyConfig.env.METRICS_HASH).toLowerCase() !== baseline.resume.metricsHash.toLowerCase() || String(studyConfig.env.METRICS_URI) !== baseline.resume.metricsUri) throw new Error("pinned metric specification mismatch");
  if (asBigInt(await biomarkers.metricCount(), "metricCount") !== BigInt(studyConfig.metrics.length) || (await biomarkers.metricsHash()).toLowerCase() !== String(studyConfig.env.METRICS_HASH).toLowerCase() || await biomarkers.metricsUri() !== String(studyConfig.env.METRICS_URI) || await biomarkers.panelFrozen()) {
    throw new Error("biomarker baseline mismatch");
  }
  for (let index = 0; index < studyConfig.metrics.length; index++) {
    const actual = await biomarkers.metricAt(index);
    const expected = studyConfig.metrics[index];
    for (const key of ["code", "unit"] as const) {
      if (actual[key].toLowerCase() !== expected[key].toLowerCase()) throw new Error(`metric ${index} ${key} mismatch`);
    }
    for (const key of ["scale", "offset", "minValue", "maxValue"] as const) {
      if (BigInt(actual[key]) !== BigInt(expected[key])) throw new Error(`metric ${index} ${key} mismatch`);
    }
  }

  const payments: any = await artifactContract("VeriarfyPayments", plan.contracts.VeriarfyPayments, provider);
  for (const [actual, expected] of [[await payments.owner(), plan.deployer], [await payments.token(), plan.contracts.PaymentToken], [await payments.protocol(), plan.contracts.VeriarfyProtocol], [await payments.researchers(), plan.contracts.VeriArfyRegistry]] as const) {
    if (!sameAddress(actual, expected)) throw new Error("payment topology mismatch");
  }
  if (asBigInt(await payments.liquidityShareBps(), "liquidityShareBps") !== 8000n || asBigInt(await payments.baseFee(), "baseFee") !== 1000000n || asBigInt(await payments.perRecordFee(), "perRecordFee") !== 50000n || asBigInt(await payments.nextQueryId(), "nextQueryId") !== 0n || asBigInt(await payments.cumulativeFees(), "cumulativeFees") !== 0n) throw new Error("payment baseline mismatch");

  const staking: any = await artifactContract("VeriarfyStaking", plan.contracts.VeriarfyStaking, provider);
  for (const [actual, expected] of [[await staking.owner(), plan.deployer], [await staking.protocol(), plan.contracts.VeriarfyProtocol], [await staking.payments(), plan.contracts.VeriarfyPayments]] as const) {
    if (!sameAddress(actual, expected)) throw new Error("staking topology mismatch");
  }
  if (asBigInt(await staking.baseStake(), "baseStake") !== BigInt(loadD15Profile().nodeBaseStakeWei) || asBigInt(await staking.valueThreshold(), "valueThreshold") !== 250000n) throw new Error("staking parameters mismatch");
  for (const node of profile.authorizedNodes) if (asBigInt(await staking.stakeOf(node), "stakeOf") !== 0n) throw new Error("new deployment node stake must be zero");

  const registry: any = await artifactContract("VeriArfyRegistry", plan.contracts.VeriArfyRegistry, provider);
  if (!sameAddress(await registry.owner(), plan.deployer) || !sameAddress(await registry.verifier(), plan.contracts.Groth16Verifier) || asBigInt(await registry.currentRoot(), "currentRoot") !== BigInt(baseline.expected.registryRoot) || asBigInt(await registry.researcherCount(), "researcherCount") !== 0n) throw new Error("registry baseline mismatch");

  const study: any = await artifactContract("AnxietyStudy", plan.contracts.AnxietyStudy, provider);
  if (!sameAddress(await study.owner(), plan.deployer) || !sameAddress(await study.registry(), plan.contracts.VeriArfyRegistry) || asBigInt(await study.participantCount(), "study participantCount") !== 0n) throw new Error("study baseline mismatch");
}

export async function verifySyntheticProofs(plan: RedeployPlan, provider: any): Promise<void> {
  const circuits: any = require("@veriarfy/circuits");
  const provenance: any = require("@veriarfy/circuits/provenance");
  const build = join(__dirname, "..", "..", "circuits", "build");
  const common = { externalNullifier: 20260814n, signerAddress: plan.deployer };
  const pInput = provenance.buildSelfProvenanceInput({ ...common, dosages: Array.from({ length: provenance.PANEL_SIZE }, (_, i) => [0, 1, 2, 1, 0, 2][i % 6]), salt: 123n, cidDigest: ethers.keccak256(ethers.toUtf8Bytes("veriarfy-redeploy-proof")) });
  const p = await fullProveIsolated(pInput, join(build, "data_provenance_js", "data_provenance.wasm"), join(build, "data_provenance_final.zkey"));
  const i = circuits.createIdentity(); const tree = new circuits.IdentityTree(); tree.insert(i.commitment);
  const id = await fullProveIsolated(circuits.buildCircuitInput({ identity: i, tree, ...common }), join(build, "researcher_identity_js", "researcher_identity.wasm"), join(build, "researcher_identity_final.zkey"));
  const protocol: any = await artifactContract("VeriarfyProtocol", plan.contracts.VeriarfyProtocol, provider);
  const registry: any = await artifactContract("VeriArfyRegistry", plan.contracts.VeriArfyRegistry, provider);
  const provenanceAddress = await protocol.provenanceVerifier();
  const identityAddress = await registry.verifier();
  if (!sameAddress(provenanceAddress, plan.contracts.DataProvenanceVerifier) || !sameAddress(identityAddress, plan.contracts.Groth16Verifier)) {
    throw new Error("deployed verifier links differ from redeploy plan");
  }
  const provenanceArtifact = await artifacts.readArtifact("DataProvenanceVerifier");
  const identityArtifact = await artifacts.readArtifact("Groth16Verifier");
  const pv: any = new ethers.Contract(provenanceAddress, provenanceArtifact.abi, provider);
  const iv: any = new ethers.Contract(identityAddress, identityArtifact.abi, provider);
  const pc = circuits.toSolidityCalldata(p.proof); const ic = circuits.toSolidityCalldata(id.proof);
  if (!(await pv.verifyProof.staticCall(pc.a, pc.b, pc.c, p.publicSignals))) throw new Error("new provenance verifier rejected synthetic proof");
  if (!(await iv.verifyProof.staticCall(ic.a, ic.b, ic.c, id.publicSignals))) throw new Error("new identity verifier rejected synthetic proof");
}

/** Durable hash precedes broadcast; retry signs exactly the same bounded payload. */
export async function submitJournaledStep(
  plan: RedeployPlan, step: RedeployPlan["steps"][number], wallet: any, provider: any,
  journal: RedeployJournal, journalPath: string,
): Promise<RedeployJournal> {
  let raw: string;
  try { raw = await wallet.signTransaction(transactionFor(plan, step)); }
  catch { throw new Error(`nonce ${step.nonce} signing failed`); }
  let signed: any;
  try { signed = ethers.Transaction.from(raw); }
  catch { throw new Error(`nonce ${step.nonce} signed payload invalid`); }
  assertTransaction(plan, step, signed);
  const txHash = ethers.keccak256(raw).toLowerCase();
  const existing = journal.entries.find(entry => entry.nonce === step.nonce);
  if (existing && existing.hash !== txHash) throw new Error(`nonce ${step.nonce} signed hash differs from journal`);
  if (!existing) {
    journal = { ...journal, entries: [...journal.entries, { nonce: step.nonce, hash: txHash }] };
    await writeJournalAtomicAsync(journal, journalPath);
  }
  let sent = await provider.getTransaction(txHash);
  if (!sent) {
    try { sent = await provider.broadcastTransaction(raw); }
    catch {
      // A dropped RPC response may still mean successful broadcast.
      sent = await provider.getTransaction(txHash);
      if (!sent) throw new Error(`nonce ${step.nonce} broadcast unconfirmed; inspect journal hash ${txHash} before resuming`);
    }
  }
  if (sent.hash.toLowerCase() !== txHash) throw new Error(`nonce ${step.nonce} broadcast hash differs`);
  assertTransaction(plan, step, sent);
  let receipt: any;
  try { receipt = await sent.wait(2, 180_000); }
  catch { throw new Error(`nonce ${step.nonce} confirmation failed/timed out; inspect journal hash ${txHash} before resuming`); }
  if (!statusOK(receipt)) throw new Error(`nonce ${step.nonce} transaction reverted or receipt missing`);
  console.log(`Confirmed nonce ${step.nonce}: ${txHash}`);
  return journal;
}

async function executePlan(plan: RedeployPlan, provider: any, progress: Progress, journalPath: string): Promise<Progress> {
  const key = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!key || process.env.NODE_PRIVATE_KEY) throw new Error("redeploy requires only DEPLOYER_PRIVATE_KEY");
  let wallet: InstanceType<typeof ethers.Wallet>;
  try { wallet = new ethers.Wallet(key, provider); }
  catch { throw new Error("deployer private key format invalid"); }
  if (!sameAddress(wallet.address, plan.deployer)) throw new Error("DEPLOYER_PRIVATE_KEY does not match plan deployer");
  let journal = progress.journal ?? { planHash: hashPlan(plan).toLowerCase(), entries: [] };
  for (const step of plan.steps) {
    progress = await inspectProgress(plan, provider, journalPath);
    await assertProfileChain(plan, provider);
    await assertReusedCode(plan, provider);
    await assertNoUnexpectedCreateCode(plan, provider, progress.completed);
    const remaining = plan.steps.filter((candidate) => !progress.completed.has(candidate.nonce))
      .reduce((sum, candidate) => sum + BigInt(candidate.gasLimit) * BigInt(plan.maxFeePerGas), 0n);
    await assertFeeAndBalance(plan, provider, remaining);
    if (progress.completed.has(step.nonce)) continue;
    if (step.nonce !== progress.latest) throw new Error(`nonce ${step.nonce} is not the verified frontier`);
    journal = await submitJournaledStep(plan, step, wallet, provider, journal, journalPath);
    progress = await inspectProgress(plan, provider, journalPath);
  }
  return progress;
}

export type OutputPairState = "absent" | "previous" | "same-plan";
export function validateOutputPair(plan: RedeployPlan, outputPaths: readonly [string, string] = [DEPLOYMENT_PATH, WEB_DEPLOYMENT_PATH]): { state: OutputPairState; record?: any } {
  const [contractPath, webPath] = outputPaths;
  const present = [existsSync(contractPath), existsSync(webPath)];
  if (!present[0] && !present[1]) return { state: "absent" };
  if (!present[0] || !present[1]) throw new Error("D15 deployment output pair incomplete");
  let contractRecord: any;
  let webRecord: any;
  try {
    contractRecord = JSON.parse(readFileSync(contractPath, "utf8"));
    webRecord = JSON.parse(readFileSync(webPath, "utf8"));
  } catch (error) {
    throw new Error(`D15 deployment output JSON invalid: ${errorText(error)}`);
  }
  if (!jsonEqual(contractRecord, webRecord)) throw new Error("D15 deployment output pair differs");
  const previous = readPreviousDeployment();
  if (jsonEqual(contractRecord, previous)) return { state: "previous", record: contractRecord };
  if (contractRecord.redeployPlanHash === hashPlan(plan)) return { state: "same-plan", record: contractRecord };
  throw new Error("unexpected active D15 deployment record");
}

export function outputRecord(plan: RedeployPlan, receipts: RedeployReceipt[]): any {
  const previous = readPreviousDeployment();
  const contracts = { ...Object.fromEntries(Object.entries(plan.reused).map(([name, item]) => [name, item.address])), ...plan.contracts };
  const earliest = Math.min(...receipts.map((receipt) => receipt.blockNumber));
  return {
    network: "sepolia", chainId: plan.chainId, deployer: plan.deployer,
    authorizedNodes: loadD15Profile().authorizedNodes, contracts, paymentTokenIsTestToken: true,
    liquidityShareBps: 8000, initialRoot: previous.initialRoot, accreditedRoot: previous.accreditedRoot,
    deployedAt: new Date().toISOString(), deployedAtBlock: earliest,
    reusedStorageDeployedAtBlock: previous.deployedAtBlock, redeployPlanHash: hashPlan(plan),
  };
}

export function assertPublishedRecord(plan: RedeployPlan, receipts: RedeployReceipt[], record: any): void {
  const expected = outputRecord(plan, receipts);
  if (typeof record.deployedAt !== "string" || !Number.isFinite(Date.parse(record.deployedAt))) throw new Error("invalid deployment timestamp");
  expected.deployedAt = record.deployedAt;
  if (!jsonEqual(record, expected)) throw new Error("published deployment differs from verified plan/receipts");
}

export async function withExecutionLock<T>(journalPath: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${journalPath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number;
  try { fd = openSync(lockPath, "wx"); }
  catch { throw new Error("D15 execution lock exists or cannot be created; inspect process and journal before recovery"); }
  try {
    writeFileSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
    return await action();
  } finally { closeSync(fd); unlinkSync(lockPath); }
}

type RedeployOptions = { plan: RedeployPlan; provider?: any; execute?: boolean; reviewPath?: string; journalPath?: string; outputPaths?: readonly [string, string] };

export async function runRedeploy(options: RedeployOptions): Promise<any> {
  const execute = options.execute ?? process.env.D15_EXECUTION_ACK?.trim() === "redeploy";
  return execute
    ? withExecutionLock(options.journalPath ?? JOURNAL_PATH, () => runRedeployLocked(options))
    : runRedeployLocked(options);
}

async function runRedeployLocked(options: RedeployOptions): Promise<any> {
  const provider = options.provider ?? ethers.provider;
  const execute = options.execute ?? process.env.D15_EXECUTION_ACK?.trim() === "redeploy";
  const ack = process.env.D15_EXECUTION_ACK?.trim() ?? "";
  if (!execute && (ack || process.env.DEPLOYER_PRIVATE_KEY || process.env.NODE_PRIVATE_KEY)) throw new Error("D15 redeploy readonly rejects signer keys and execution ack");
  if (execute) {
    if (ack !== "redeploy" || process.env.D15_PROFILE?.trim() !== "d15-sepolia-2of2-ml" || process.env.NODE_PRIVATE_KEY) throw new Error("redeploy requires D15_PROFILE, ACK=redeploy, and no NODE_PRIVATE_KEY");
    const signers = await ethers.getSigners();
    if (signers.length !== 1 || !sameAddress(await signers[0].getAddress(), options.plan.deployer)) throw new Error("redeploy requires exactly one matching deployer signer");
  }
  const plan = options.plan;
  const freshPlan = await buildRedeployPlan();
  if (hashPlan(freshPlan) !== hashPlan(plan)) throw new Error("caller plan differs from freshly pinned D15 plan");
  readAndAssertReview(plan, options.reviewPath ?? REVIEW_PATH);
  const progress = await assertPreflight(plan, provider, await inspectProgress(plan, provider, options.journalPath));
  const outputState = validateOutputPair(plan, options.outputPaths ?? [DEPLOYMENT_PATH, WEB_DEPLOYMENT_PATH]);
  if (!execute) {
    if (outputState.state === "same-plan") {
      if (progress.completed.size !== plan.steps.length) throw new Error("same-plan output exists before plan completion");
      assertPublishedRecord(plan, progress.receipts, outputState.record);
      await verifyFinalState(plan, provider);
      await verifySyntheticProofs(plan, provider);
      return { mode: "readonly", review: "verified", progress, record: outputState.record };
    }
    return { mode: "readonly", review: "verified", output: outputState.state, progress };
  }
  if (outputState.state === "same-plan") {
    if (progress.completed.size !== plan.steps.length) throw new Error("same-plan output exists before plan completion");
    assertPublishedRecord(plan, progress.receipts, outputState.record);
    await verifyFinalState(plan, provider);
    await verifySyntheticProofs(plan, provider);
    return outputState.record;
  }
  const done = await executePlan(plan, provider, progress, options.journalPath ?? JOURNAL_PATH);
  await verifyFinalState(plan, provider);
  await verifySyntheticProofs(plan, provider);
  if (done.completed.size !== plan.steps.length) throw new Error("D15 plan incomplete after execution");
  const record = outputRecord(plan, done.receipts);
  publishD15OutputPair(options.outputPaths ?? [DEPLOYMENT_PATH, WEB_DEPLOYMENT_PATH], `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function main(): Promise<void> {
  const plan = await buildRedeployPlan();
  const result = await runRedeploy({ plan });
  console.log(JSON.stringify({ mode: result.mode ?? "complete", planHash: hashPlan(plan), latest: result.progress?.latest, review: result.review }, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(errorText(error)); process.exitCode = 1; });
