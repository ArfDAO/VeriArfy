import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ethers, fhevm, network } from "hardhat";
import { getAddress, keccak256, toUtf8Bytes, ZeroAddress, Wallet } from "ethers";

import { fullProveIsolated } from "./isolated-proof";
import {
  emptyD17State,
  loadD17State,
  recordTx,
  saveD17State,
  type D17Participant,
  type D17State,
  type D17Tx,
  withD17StateLockAsync,
} from "./multi-participant-state";
import { D15_PROFILE_ID, loadD15Profile, sameAddress } from "./d15-profile";

const CHAIN_ID = 11155111n;
const PANEL_SNP_COUNT = 10;
const QUERY_TYPE = 2;
const QUERY_SNPS = [0, 1];
const BATCH_SIZE = 4;
const DEFAULT_FUND_WEI = ethers.parseEther("0.018");
const DEFAULT_FUND_CAP_WEI = ethers.parseEther("0.075");
const DEFAULT_MAX_FEE = ethers.parseUnits("2", "gwei");
const DEFAULT_PRIORITY_FEE = ethers.parseUnits("0.1", "gwei");
const CONTRACT_GAS_CAP = 12_000_000n;
const TOTAL_SPEND_CAP = ethers.parseEther("0.10");
const NODE1_ROLE_CAP = ethers.parseEther("0.075");

type AnyContract = any;
type Receipt = any;

function fail(message: string): never { throw new Error(`D17: ${message}`); }

function stateFile(): string {
  const raw = process.env.D17_STATE_PATH?.trim();
  return raw || join(__dirname, "..", "ops", "d17-sepolia-state.json");
}

function executionEnabled(): boolean { return process.env.D17_EXECUTE === "1"; }

function stage(): string {
  const value = process.env.D17_STAGE?.trim();
  if (!value) fail("D17_STAGE zorunludur");
  return value;
}

function role(): string { return process.env.D17_ROLE?.trim() || "none"; }

function parseAddresses(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const values = raw.split(",").map((item) => item.trim()).filter(Boolean);
  const addresses = values.map((item) => {
    try { return getAddress(item); } catch { fail(`D17_PARTICIPANTS adresi gecersiz: ${item}`); }
  });
  if (new Set(addresses.map((address) => address.toLowerCase())).size !== addresses.length) {
    fail("D17_PARTICIPANTS distinct adreslerden olusmali");
  }
  return addresses;
}

function addressKey(address: string): string { return address.toLowerCase(); }

function asBigInt(value: unknown, label: string): bigint {
  try { return BigInt(value as bigint); } catch { fail(`${label} bigint degil`); }
}

function txRecord(
  roleName: string,
  kind: string,
  signer: string,
  tx: any,
  receipt: Receipt,
): D17Tx {
  return {
    role: roleName,
    kind,
    from: getAddress(signer),
    to: typeof tx.to === "string" ? getAddress(tx.to) : undefined,
    hash: tx.hash,
    nonce: Number(tx.nonce),
    valueWei: tx.value === undefined ? undefined : asBigInt(tx.value, "tx.value").toString(),
    gasLimit: tx.gasLimit === undefined ? undefined : asBigInt(tx.gasLimit, "gasLimit").toString(),
    maxFeePerGas: tx.maxFeePerGas === undefined ? undefined : asBigInt(tx.maxFeePerGas, "maxFeePerGas").toString(),
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas === undefined ? undefined : asBigInt(tx.maxPriorityFeePerGas, "maxPriorityFeePerGas").toString(),
    gasUsed: receipt?.gasUsed === undefined ? undefined : asBigInt(receipt.gasUsed, "gasUsed").toString(),
    effectiveGasPriceWei: receipt?.gasPrice === undefined ? undefined : asBigInt(receipt.gasPrice, "gasPrice").toString(),
    blockNumber: receipt?.blockNumber === undefined ? undefined : Number(receipt.blockNumber),
    status: "confirmed",
  };
}

async function reconcilePending(state: D17State, path: string): Promise<void> {
  let changed = false;
  for (const journal of state.txs.filter((item) => item.status === "prepared" || item.status === "broadcast")) {
    const receipt = await ethers.provider.getTransactionReceipt(journal.hash);
    if (!receipt) {
      fail(`pending/prepared transaction reconcile gerekli; yeniden imzalama yok: ${journal.kind} ${journal.hash}`);
    }
    if (Number(receipt.status) !== 1) fail(`pending transaction reverted: ${journal.hash}`);
    Object.assign(journal, {
      status: "confirmed",
      gasUsed: asBigInt(receipt.gasUsed, "gasUsed").toString(),
      effectiveGasPriceWei: receipt.gasPrice === undefined ? undefined : asBigInt(receipt.gasPrice, "gasPrice").toString(),
      blockNumber: Number(receipt.blockNumber),
    });
    changed = true;
  }
  if (changed) saveD17State(path, state);
}

function maxFee(): bigint {
  const raw = process.env.D17_MAX_FEE_GWEI?.trim();
  const value = raw ? ethers.parseUnits(raw, "gwei") : DEFAULT_MAX_FEE;
  if (value > DEFAULT_MAX_FEE) fail("D17_MAX_FEE_GWEI reviewed cap 2 gwei'yi asamaz");
  return value;
}

function priorityFee(): bigint {
  const raw = process.env.D17_PRIORITY_FEE_GWEI?.trim();
  const value = raw ? ethers.parseUnits(raw, "gwei") : DEFAULT_PRIORITY_FEE;
  if (value > DEFAULT_PRIORITY_FEE) fail("D17_PRIORITY_FEE_GWEI reviewed cap 0.1 gwei'yi asamaz");
  return value;
}

function boundedWei(name: string, raw: string | undefined, fallback: bigint, hardCap: bigint): bigint {
  const value = raw?.trim() ? BigInt(raw) : fallback;
  if (value <= 0n || value > hardCap) fail(`${name} reviewed cap disinda`);
  return value;
}

function totalSpendCap(): bigint {
  return boundedWei("D17_TOTAL_SPEND_CAP_WEI", process.env.D17_TOTAL_SPEND_CAP_WEI, TOTAL_SPEND_CAP, TOTAL_SPEND_CAP);
}

function node1RoleCap(): bigint {
  return boundedWei("D17_NODE1_ROLE_CAP_WEI", process.env.D17_NODE1_ROLE_CAP_WEI, NODE1_ROLE_CAP, NODE1_ROLE_CAP);
}

function maxGasCap(): bigint {
  return boundedWei("D17_MAX_GAS", process.env.D17_MAX_GAS, CONTRACT_GAS_CAP, CONTRACT_GAS_CAP);
}

function txUpperBound(tx: D17Tx): bigint {
  const value = tx.valueWei ? BigInt(tx.valueWei) : 0n;
  if (tx.status === "confirmed") {
    if (!tx.gasUsed || !tx.effectiveGasPriceWei) fail(`confirmed tx gas kaydi eksik: ${tx.hash}`);
    return value + BigInt(tx.gasUsed) * BigInt(tx.effectiveGasPriceWei);
  }
  if (tx.gasLimit === undefined || tx.maxFeePerGas === undefined) fail(`pending tx spend kaydi eksik: ${tx.hash}`);
  return value + BigInt(tx.gasLimit) * BigInt(tx.maxFeePerGas);
}

function assertSpendBudget(state: D17State, roleName: string, from: string, value: bigint, gasLimit: bigint): void {
  const projected: D17Tx = {
    kind: "projected",
    role: roleName,
    from: getAddress(from),
    hash: "0x" + "00".repeat(32),
    valueWei: value.toString(),
    gasLimit: gasLimit.toString(),
    maxFeePerGas: maxFee().toString(),
    status: "prepared",
  };
  const total = state.txs.reduce((sum, tx) => sum + txUpperBound(tx), 0n) + txUpperBound(projected);
  if (total > totalSpendCap()) fail(`D17 total spend cap exceeded: ${total} > ${totalSpendCap()}`);
  if (roleName === "node-1") {
    const roleSpend = state.txs.filter((tx) => tx.role === "node-1").reduce((sum, tx) => sum + txUpperBound(tx), 0n) + txUpperBound(projected);
    if (roleSpend > node1RoleCap()) fail(`node-1 role spend cap exceeded: ${roleSpend} > ${node1RoleCap()}`);
  }
}

async function feeOverrides(): Promise<Record<string, bigint>> {
  const fee = maxFee();
  const priority = priorityFee();
  if (priority > fee) fail("priority fee max fee'den buyuk");
  const data = await ethers.provider.getFeeData();
  const latest = await ethers.provider.getBlock("latest");
  const base = latest?.baseFeePerGas ?? data.gasPrice;
  if (base !== null && base !== undefined && base + priority > fee) {
    fail(`fee cap yetersiz: base+priority=${ethers.formatUnits(base + priority, "gwei")} gwei`);
  }
  return { maxFeePerGas: fee, maxPriorityFeePerGas: priority };
}

function assertStateWriteAllowed(label: string): void {
  if (!executionEnabled()) fail(`${label} icin D17_EXECUTE=1 zorunludur`);
}

function deploymentRecord(): any {
  const path = join(__dirname, "..", "deployments", `${network.name}.json`);
  let record: any;
  try { record = JSON.parse(readFileSync(path, "utf8")); } catch { fail(`deployment okunamadi: ${path}`); }
  if (record.network !== "sepolia" || Number(record.chainId) !== Number(CHAIN_ID)) {
    fail("deployment Sepolia 11155111 degil");
  }
  for (const field of ["VeriarfyProtocol", "VeriarfyPayments", "VeriarfyStaking", "PaymentToken"]) {
    if (!record.contracts?.[field] || !ethers.isAddress(record.contracts[field])) {
      fail(`deployment ${field} adresi eksik/gecersiz`);
    }
  }
  const profile = loadD15Profile();
  if (!sameAddress(record.deployer, profile.deployer)) fail("deployer D15 profile ile eslesmiyor");
  if (!Array.isArray(record.authorizedNodes) || record.authorizedNodes.length !== 2) {
    fail("authorizedNodes tam iki adres olmali");
  }
  if (!sameAddress(record.authorizedNodes[0], profile.authorizedNodes[0]) ||
      !sameAddress(record.authorizedNodes[1], profile.authorizedNodes[1])) {
    fail("authorizedNodes D15 profile ile eslesmiyor");
  }
  return record;
}

async function assertDeploymentIntegrity(record: any): Promise<void> {
  const reviewPath = join(__dirname, "..", "ops", "d15-redeploy-review.json");
  let review: any;
  try { review = JSON.parse(readFileSync(reviewPath, "utf8")); } catch { fail("pinned D15 review manifest okunamadi"); }
  if (Number(review.chainId) !== Number(CHAIN_ID) || review.planHash !== "0xd026de9debced25767b1d6d5b023aa2157318ede64204a3a27ee14da8d15a62c") {
    fail("pinned D15 review manifest canonical degil");
  }
  const byName = new Map<string, string>();
  const canonicalAddressByName = new Map<string, string>();
  for (const [name, item] of Object.entries(review.reused ?? {})) {
    const value = item as any;
    if (value.runtimeHash) byName.set(name, String(value.runtimeHash).toLowerCase());
    if (value.address) canonicalAddressByName.set(name, getAddress(String(value.address)));
  }
  for (const item of review.steps ?? []) {
    if (item.contractName && item.runtimeHash) byName.set(String(item.contractName), String(item.runtimeHash).toLowerCase());
    if (item.contractName && item.address) canonicalAddressByName.set(String(item.contractName), getAddress(String(item.address)));
  }
  for (const [name, rawAddress] of Object.entries(record.contracts)) {
    const address = getAddress(String(rawAddress));
    const lookupName = name === "PaymentToken" ? "StableTestToken" : name;
    const canonicalAddress = canonicalAddressByName.get(lookupName);
    if (!canonicalAddress || !sameAddress(address, canonicalAddress)) fail(`pinned canonical address uyusmuyor: ${name}`);
    const expected = byName.get(lookupName);
    if (!expected) fail(`pinned runtime evidence eksik: ${name}`);
    const code = await ethers.provider.getCode(address);
    if (code === "0x" || keccak256(code).toLowerCase() !== expected) fail(`pinned runtime hash uyusmuyor: ${name}`);
  }
  const { protocol, payments, staking } = await protocolAndPayments(record);
  const registry = await ethers.getContractAt("VeriArfyRegistry", record.contracts.VeriArfyRegistry);
  const expectLink = async (label: string, actual: string, expected: string) => {
    if (!sameAddress(actual, expected)) fail(`linked topology uyusmuyor: ${label}`);
  };
  await expectLink("protocol.provenanceVerifier", await protocol.provenanceVerifier(), record.contracts.DataProvenanceVerifier);
  await expectLink("protocol.queryGateway", await protocol.queryGateway(), record.contracts.VeriarfyPayments);
  await expectLink("protocol.stakingModule", await protocol.stakingModule(), record.contracts.VeriarfyStaking);
  await expectLink("protocol.biomarkerModule", await protocol.biomarkerModule(), record.contracts.VeriarfyBiomarkers);
  await expectLink("payments.protocol", await payments.protocol(), record.contracts.VeriarfyProtocol);
  await expectLink("payments.token", await payments.token(), record.contracts.PaymentToken);
  await expectLink("payments.researchers", await payments.researchers(), record.contracts.VeriArfyRegistry);
  await expectLink("staking.protocol", await staking.protocol(), record.contracts.VeriarfyProtocol);
  await expectLink("staking.payments", await staking.payments(), record.contracts.VeriarfyPayments);
  await expectLink("registry.verifier", await registry.verifier(), record.contracts.Groth16Verifier);
}

async function assertSepolia(): Promise<void> {
  if (network.name !== "sepolia") fail(`yalniz sepolia destekleniyor (network=${network.name})`);
  const chain = await ethers.provider.getNetwork();
  if (chain.chainId !== CHAIN_ID) fail(`chainId ${chain.chainId} != ${CHAIN_ID}`);
}

async function oneSigner(required: boolean): Promise<any | null> {
  const signers = await ethers.getSigners();
  if (!required && signers.length === 0) return null;
  if (signers.length !== 1) fail(`tam bir D17 signer bekleniyor, bulunan=${signers.length}`);
  return signers[0];
}

function signerAddress(signer: any | null): string | null {
  return signer ? getAddress(signer.address) : null;
}

function participantAddresses(state: D17State): string[] {
  const fromEnv = parseAddresses(process.env.D17_PARTICIPANTS);
  if (fromEnv.length > 0) return fromEnv;
  return Object.values(state.participants)
    .sort((left, right) => left.role.localeCompare(right.role))
    .map((participant) => getAddress(participant.address));
}

function roleParticipantAddress(state: D17State, roleName: string): string {
  const match = /^participant-([1-9][0-9]*)$/.exec(roleName);
  if (!match) fail(`katilimci role gecersiz: ${roleName}`);
  const index = Number(match[1]) - 1;
  const addresses = participantAddresses(state);
  if (index < 0 || index >= addresses.length) fail(`${roleName} icin katilimci adresi yok`);
  return addresses[index];
}

function ensureParticipantState(state: D17State, addresses: string[]): void {
  if (addresses.length < 3 || addresses.length > 5) fail("D17 tam 3-5 katilimci ister");
  addresses.forEach((address, index) => {
    const key = addressKey(address);
    const expectedCoverage = index === 0 ? [0, 1] : [0];
    const existing = state.participants[key];
    if (existing && !sameAddress(existing.address, address)) fail("state participant adresi bozuk");
    if (!existing) {
      state.participants[key] = {
        role: `participant-${index + 1}`,
        address,
        coverage: expectedCoverage,
        txs: [],
      };
    } else if (existing.role !== `participant-${index + 1}` ||
               JSON.stringify(existing.coverage) !== JSON.stringify(expectedCoverage)) {
      fail(`${address} state coverage/role ile D17 cohort uyusmuyor`);
    }
  });
}

async function protocolAndPayments(record: any): Promise<{ protocol: AnyContract; payments: AnyContract; staking: AnyContract; token: AnyContract }> {
  return {
    protocol: await ethers.getContractAt("VeriarfyProtocol", record.contracts.VeriarfyProtocol),
    payments: await ethers.getContractAt("VeriarfyPayments", record.contracts.VeriarfyPayments),
    staking: await ethers.getContractAt("VeriarfyStaking", record.contracts.VeriarfyStaking),
    token: await ethers.getContractAt("StableTestToken", record.contracts.PaymentToken),
  };
}

async function sendContract(
  state: D17State,
  path: string,
  roleName: string,
  kind: string,
  signer: any,
  contract: AnyContract,
  method: string,
  args: unknown[],
  value?: bigint,
  metadata: Pick<D17Tx, "expectedQueryId" | "expectedRequestId"> = {},
): Promise<{ tx: any; receipt: Receipt; journal: D17Tx }> {
  const connected = contract.connect(signer);
  const fn = connected.getFunction(method);
  const request = await fn.populateTransaction(...args);
  const fees = await feeOverrides();
  const gas = await ethers.provider.estimateGas({
    ...request,
    from: signer.address,
    ...(value === undefined ? {} : { value }),
  });
  const cap = maxGasCap();
  const gasLimit = gas + gas / 5n + 10_000n;
  if (gasLimit > cap) fail(`${kind} tahmini gaz cap'i asiyor: ${gasLimit} > ${cap}`);
  const requestWithFees = {
    ...request,
    ...fees,
    gasLimit,
    chainId: Number(CHAIN_ID),
    nonce: await nextNonce(state, signer.address),
    ...(value === undefined ? {} : { value }),
  };
  assertSpendBudget(state, roleName, signer.address, value ?? 0n, gasLimit);
  const wallet = signingWallet(signer.address);
  const raw = await wallet.signTransaction(requestWithFees);
  const signedHash = keccak256(raw);
  const provisional: D17Tx = {
    role: roleName,
    kind,
    from: getAddress(signer.address),
    to: typeof requestWithFees.to === "string" ? getAddress(requestWithFees.to) : undefined,
    hash: signedHash,
    nonce: Number(requestWithFees.nonce),
    valueWei: value?.toString(),
    gasLimit: gasLimit.toString(),
    maxFeePerGas: requestWithFees.maxFeePerGas.toString(),
    maxPriorityFeePerGas: requestWithFees.maxPriorityFeePerGas.toString(),
    ...metadata,
    status: "prepared",
  };
  recordTx(state, provisional);
  saveD17State(path, state);
  const tx = await ethers.provider.broadcastTransaction(raw);
  if (tx.hash.toLowerCase() !== signedHash.toLowerCase()) fail(`${kind} signed hash mismatch`);
  provisional.status = "broadcast";
  saveD17State(path, state);
  const receipt = await tx.wait();
  if (!receipt || Number(receipt.status) !== 1) fail(`${kind} receipt basarisiz`);
  const confirmed = txRecord(roleName, kind, signer.address, tx, receipt);
  const stored = state.txs.find((item) => item.hash.toLowerCase() === tx.hash.toLowerCase());
  if (stored) Object.assign(stored, confirmed);
  else recordTx(state, confirmed);
  saveD17State(path, state);
  return { tx, receipt, journal: confirmed };
}

async function sendValue(
  state: D17State,
  path: string,
  roleName: string,
  kind: string,
  signer: any,
  to: string,
  value: bigint,
): Promise<D17Tx> {
  const fees = await feeOverrides();
  const request = {
    to,
    value,
    gasLimit: 21_000n,
    ...fees,
    chainId: Number(CHAIN_ID),
    nonce: await nextNonce(state, signer.address),
  };
  assertSpendBudget(state, roleName, signer.address, value, 21_000n);
  const wallet = signingWallet(signer.address);
  const raw = await wallet.signTransaction(request);
  const signedHash = keccak256(raw);
  const provisional: D17Tx = {
    role: roleName, kind, from: getAddress(signer.address), to: getAddress(to),
    hash: signedHash, nonce: Number(request.nonce), valueWei: value.toString(), gasLimit: "21000",
    maxFeePerGas: (request as any).maxFeePerGas.toString(), maxPriorityFeePerGas: (request as any).maxPriorityFeePerGas.toString(), status: "prepared",
  };
  recordTx(state, provisional);
  saveD17State(path, state);
  const tx = await ethers.provider.broadcastTransaction(raw);
  if (tx.hash.toLowerCase() !== signedHash.toLowerCase()) fail(`${kind} signed hash mismatch`);
  provisional.status = "broadcast";
  saveD17State(path, state);
  const receipt = await tx.wait();
  if (!receipt || Number(receipt.status) !== 1) fail(`${kind} receipt basarisiz`);
  const confirmed = txRecord(roleName, kind, signer.address, tx, receipt);
  const stored = state.txs.find((item) => item.hash.toLowerCase() === tx.hash.toLowerCase());
  if (stored) Object.assign(stored, confirmed);
  saveD17State(path, state);
  return confirmed;
}

function signingWallet(expectedAddress: string): Wallet {
  const raw = process.env.D17_PRIVATE_KEY?.trim();
  if (!raw) fail("D17_PRIVATE_KEY broadcast asamasinda yok");
  let wallet: Wallet;
  try { wallet = new Wallet(raw, ethers.provider); } catch { fail("D17_PRIVATE_KEY gecersiz"); }
  if (!sameAddress(wallet.address, expectedAddress)) fail("D17_PRIVATE_KEY signer role ile eslesmiyor");
  return wallet;
}

async function nextNonce(state: D17State, address: string): Promise<number> {
  const latest = await ethers.provider.getTransactionCount(address, "latest");
  const pending = await ethers.provider.getTransactionCount(address, "pending");
  if (pending > latest) {
    const known = state.txs.some((tx) => tx.status !== "confirmed" && tx.nonce !== undefined && tx.nonce >= latest && sameAddress(tx.from, address));
    if (!known) fail(`unknown pending nonce ${latest}; broadcast reconcile gerekli`);
  }
  return pending;
}

async function baselineParticipants(protocol: AnyContract, record: any, block: number, count: number): Promise<string[]> {
  const start = Number(record.deployedAtBlock ?? Math.max(0, block - 100_000));
  const topics = [
    protocol.interface.getEvent("DosageAggregated").topicHash,
    protocol.interface.getEvent("DosagesContributed").topicHash,
  ];
  const logs = await ethers.provider.getLogs({ address: await protocol.getAddress(), topics: [topics], fromBlock: start, toBlock: block });
  const candidates: string[] = [getAddress(record.deployer), ...record.authorizedNodes.map((item: string) => getAddress(item))];
  for (const log of logs) {
    const parsed = protocol.interface.parseLog(log);
    const address = parsed?.args?.participant;
    if (typeof address === "string" && !candidates.some((item) => sameAddress(item, address))) candidates.push(getAddress(address));
  }
  const found = new Map<number, string>();
  for (const candidate of candidates) {
    const index = Number(await protocol.participantIndex(candidate, { blockTag: block }));
    if (index === 0) continue;
    if (index > count || !(await protocol.hasAggregated(candidate, { blockTag: block }))) fail(`baseline participant index invalid: ${candidate} -> ${index}`);
    if (found.has(index) && !sameAddress(found.get(index)!, candidate)) fail(`baseline participant index collision: ${index}`);
    found.set(index, candidate);
  }
  if (found.size !== count) fail(`baseline participant completeness mismatch: found=${found.size}, count=${count}`);
  const ordered: string[] = [];
  for (let index = 1; index <= count; index++) {
    const participant = found.get(index);
    if (!participant) fail(`baseline participant index ${index} missing at block ${block}`);
    ordered.push(getAddress(participant));
  }
  return ordered;
}

async function captureBaseline(protocol: AnyContract, record: any, capturedBlock?: number): Promise<D17State["baseline"]> {
  const block = capturedBlock ?? await ethers.provider.getBlockNumber();
  const count = Number(await protocol.participantCount({ blockTag: block }));
  const participants = await baselineParticipants(protocol, record, block, count);
  return {
    capturedAtBlock: block,
    participantCount: count,
    coverage: {
      "0": (await protocol.snpCoverageCount(0, { blockTag: block })).toString(),
      "1": (await protocol.snpCoverageCount(1, { blockTag: block })).toString(),
    },
    rareCarrierCount: Number(await protocol.rareCarrierCount({ blockTag: block })),
    participants,
  };
}

function panelFor(coverage: number[]): number[] {
  const covered = new Set(coverage);
  return Array.from({ length: 1000 }, (_, index) => {
    if (!covered.has(index)) return 3;
    if (index === 0) return coverage.includes(1) ? 2 : 1;
    return 1;
  });
}

async function participantStage(state: D17State, path: string, record: any, signer: any, roleName: string): Promise<void> {
  assertStateWriteAllowed("participant");
  const address = roleParticipantAddress(state, roleName);
  if (!sameAddress(address, signer.address)) fail(`${roleName} signer adresi D17_PARTICIPANTS ile eslesmiyor`);
  const { protocol } = await protocolAndPayments(record);
  await fhevm.initializeCLIApi();
  const participant = state.participants[addressKey(address)];
  if (!participant) fail(`${roleName} state kaydi yok`);
  const panel = panelFor(participant.coverage);
  const existingCid = await protocol.userCIDs(address);
  let commitment = await protocol.panelCommitment(address);
  if (existingCid === ZeroAddress || existingCid === ethers.ZeroHash) {
    const provenance = await import("@veriarfy/circuits/provenance");
    const circuits = await import("@veriarfy/circuits");
    const cidDigest = keccak256(toUtf8Bytes(`veriarfy-d17-${address}-${Date.now()}-${Math.random()}`));
    const salt = provenance.randomSalt();
    commitment = provenance.panelCommitment(panel, salt);
    const input = provenance.buildSelfProvenanceInput({
      dosages: panel,
      salt,
      externalNullifier: await protocol.PROVENANCE_SCOPE(),
      cidDigest,
      signerAddress: address,
    });
    const build = join(__dirname, "..", "..", "circuits", "build");
    const result = await fullProveIsolated(input, join(build, "data_provenance_js", "data_provenance.wasm"), join(build, "data_provenance_final.zkey"));
    const calldata = circuits.toSolidityCalldata(result.proof);
    const verifier = await ethers.getContractAt("DataProvenanceVerifier", await protocol.provenanceVerifier());
    const valid = await verifier.verifyProof.staticCall(calldata.a, calldata.b, calldata.c, result.publicSignals);
    if (!valid) fail(`${roleName} provenance proof verifier reddetti`);
    const altered = [...result.publicSignals];
    altered[0] = (BigInt(altered[0]) + 1n).toString();
    if (await verifier.verifyProof.staticCall(calldata.a, calldata.b, calldata.c, altered)) {
      fail(`${roleName} provenance verifier altered signal kabul etti`);
    }
    // Persist only public verification evidence before broadcast.  The witness
    // and salt never enter resumable state; a pending broadcast is reconciled
    // by hash before this stage can submit anything else.
    state.checks = { ...(state.checks ?? {}), [`${roleName}:proof`]: true, [`${roleName}:alteredSignalRejected`]: true };
    saveD17State(path, state);
    const journal = await sendContract(state, path, roleName, "participant-record", signer, protocol, "submitRecord", [
      cidDigest, false, 0n,
      provenance.computeProvenanceNullifier(await protocol.PROVENANCE_SCOPE(), commitment),
      commitment, provenance.coverageWords(panel), calldata.a, calldata.b, calldata.c,
    ]);
    participant.txs.push(journal.journal);
    participant.cidDigest = cidDigest;
    participant.commitment = commitment;
    participant.recordSubmitted = true;
    saveD17State(path, state);
  } else {
    participant.cidDigest = existingCid;
    participant.commitment = commitment;
    participant.recordSubmitted = true;
    saveD17State(path, state);
  }

  const group = roleName === "participant-1" ? 1 : 0;
  if (!(await protocol.isEnrolled(address))) {
    const enc = await fhevm.createEncryptedInput(await protocol.getAddress(), address).add8(group).encrypt();
    const result = await sendContract(state, path, roleName, "participant-enroll", signer, protocol, "enroll", [enc.handles[0], enc.inputProof]);
    participant.txs.push(result.journal);
  }
  participant.enrolled = true;

  const snpCount = Number(await protocol.snpCount());
  if (snpCount !== PANEL_SNP_COUNT) fail(`panel snpCount=${snpCount}; D17 10 olmali`);
  let submitted = Number(await protocol.submittedSnps(address));
  while (submitted < snpCount) {
    const size = Math.min(BATCH_SIZE, snpCount - submitted);
    const input = fhevm.createEncryptedInput(await protocol.getAddress(), address);
    for (let offset = 0; offset < size; offset++) {
      const snp = submitted + offset;
      input.add8(panel[snp]);
    }
    const encrypted = await input.encrypt();
    let mask = 0n;
    for (let offset = 0; offset < size; offset++) {
      if (participant.coverage.includes(submitted + offset)) mask |= 1n << BigInt(offset);
    }
    const result = await sendContract(state, path, roleName, `participant-contribute-${submitted}-${submitted + size}`, signer, protocol, "contributeDosages", [encrypted.handles, mask, encrypted.inputProof]);
    participant.txs.push(result.journal);
    submitted = Number(await protocol.submittedSnps(address));
  }
  participant.submittedSnps = submitted;

  if ((await protocol.rarityConfirmedAtBlock(address)) === 0n) {
    if (!(await protocol.rarityRequested(address))) {
      const result = await sendContract(state, path, roleName, "participant-rarity-request", signer, protocol, "requestRarityAssessment", []);
      participant.txs.push(result.journal);
    }
    const handle = await protocol.rarityHandle(address);
    const decryption = await fhevm.publicDecrypt([handle]);
    const clearBit = Boolean((decryption.clearValues as any)[handle.toLowerCase()]);
    const expectedRare = roleName === "participant-1";
    if (clearBit !== expectedRare) fail(`${roleName} rarity sonucu beklenmedik: ${clearBit}`);
    const result = await sendContract(state, path, roleName, "participant-rarity-confirm", signer, protocol, "confirmRarity", [address, decryption.abiEncodedClearValues, decryption.decryptionProof]);
    participant.txs.push(result.journal);
  }
  participant.rarityRequested = Boolean(await protocol.rarityRequested(address));
  participant.rarityConfirmed = (await protocol.rarityConfirmedAtBlock(address)) !== 0n;
  participant.isRare = Boolean(await protocol.isRareCarrier(address));
  if (participant.isRare !== (roleName === "participant-1")) fail(`${roleName} final rarity beklenmedik`);
  saveD17State(path, state);
}

async function fundStage(state: D17State, path: string, record: any, signer: any): Promise<void> {
  assertStateWriteAllowed("fund");
  if (role() !== "node-1" || !sameAddress(signer.address, record.authorizedNodes[0])) fail("fund yalniz node-1 signer ile calisir");
  const amount = boundedWei("D17_FUND_PER_PARTICIPANT_WEI", process.env.D17_FUND_PER_PARTICIPANT_WEI, DEFAULT_FUND_WEI, DEFAULT_FUND_WEI);
  const cap = boundedWei("D17_FUND_MAX_TOTAL_WEI", process.env.D17_FUND_MAX_TOTAL_WEI, DEFAULT_FUND_CAP_WEI, NODE1_ROLE_CAP);
  const addresses = participantAddresses(state);
  if (amount <= 0n || amount * BigInt(addresses.length) > cap) fail("funding cap/amount gecersiz");
  const balance = await ethers.provider.getBalance(signer.address);
  const required = amount * BigInt(addresses.length);
  if (balance < required + ethers.parseEther("0.02")) fail("node-1 funding sonrasi guvenli ETH bakiyesi kalmiyor");
  for (const address of addresses) {
    const key = addressKey(address);
    if (state.checks?.[`funded:${key}`] === true || (await ethers.provider.getBalance(address)) >= amount) {
      state.checks = { ...(state.checks ?? {}), [`funded:${key}`]: true };
      continue;
    }
    const journal = await sendValue(state, path, "node-1", "fund-participant", signer, address, amount);
    state.participants[key].txs.push(journal);
    state.checks = { ...(state.checks ?? {}), [`funded:${key}`]: true };
    saveD17State(path, state);
  }
}

function queryStateFromOnchain(queryId: bigint, query: any, journal: D17Tx): NonNullable<D17State["query"]> {
  return {
    queryId: queryId.toString(),
    requestId: asBigInt(query.disclosureRequestId, "requestId").toString(),
    queryType: QUERY_TYPE,
    snpIds: [...QUERY_SNPS],
    snapshotCount: Number(query.snapshotCount),
    fee: asBigInt(query.fee, "query.fee").toString(),
    openedAtBlock: Number(query.openedAtBlock),
    txs: [journal],
  };
}

export function findConfirmedResearcherOpenJournal(state: D17State): D17Tx | undefined {
  return [...state.txs].reverse().find((item) => item.kind === "researcher-open-query" && item.status === "confirmed");
}

async function assertQueryOpenedReceipt(payments: AnyContract, journal: D17Tx, queryId: bigint, requestId: bigint, researcher: string): Promise<void> {
  const receipt = await ethers.provider.getTransactionReceipt(journal.hash);
  if (!receipt) fail(`researcher query receipt okunamadi: ${journal.hash}`);
  for (const log of receipt.logs) {
    try {
      const parsed = payments.interface.parseLog(log);
      if (parsed?.name === "QueryOpened" && asBigInt(parsed.args.queryId, "event query id") === queryId) {
        if (!sameAddress(parsed.args.researcher, researcher) || asBigInt(parsed.args.disclosureRequestId, "event request id") !== requestId) fail("researcher QueryOpened receipt binding mismatch");
        return;
      }
    } catch { /* a log from another contract */ }
  }
  fail(`QueryOpened event bulunamadi: ${journal.hash}`);
}

async function assertQueryBinding(
  query: any,
  protocol: AnyContract,
  payments: AnyContract,
  record: any,
  queryId: bigint,
  expectedRequestId: bigint,
  state: D17State,
): Promise<void> {
  if (!state.baseline) fail("query binding baseline yok");
  if (!sameAddress(query.researcher, record.deployer)) fail("query researcher deployer ile eslesmiyor");
  if (asBigInt(query.disclosureRequestId, "query request") !== expectedRequestId) fail("query/request id handoff uyusmuyor");
  if (Number(query.snapshotCount) !== state.baseline.participantCount + participantAddresses(state).length) fail("query snapshot baseline/cohort ile uyusmuyor");
  const snps = (await protocol.disclosureSnpIds(expectedRequestId)).map((item: unknown) => Number(item));
  const metrics = await protocol.disclosureMetricIds(expectedRequestId);
  if (JSON.stringify(snps) !== JSON.stringify(QUERY_SNPS) || metrics.length !== 0) fail("query disclosure fields D17 [0,1]/empty metric degil");
  const disclosure = await protocol.disclosureRequest(expectedRequestId);
  if (!sameAddress(disclosure.requester, record.deployer) || Number(disclosure.snapshotCount) !== Number(query.snapshotCount) || asBigInt(await protocol.disclosureRequiredApprovals(expectedRequestId), "required approvals") !== 2n) fail("query disclosure binding topology/approval uyusmuyor");
  if (queryId < 0n || asBigInt(await payments.nextQueryId(), "nextQueryId") <= queryId) fail("queryId nextQueryId ile uyusmuyor");
}

async function researcherStage(state: D17State, path: string, record: any, signer: any): Promise<void> {
  assertStateWriteAllowed("researcher");
  if (role() !== "deployer" || !sameAddress(signer.address, record.deployer)) fail("researcher yalniz deployer signer ile calisir");
  const { protocol, payments, token } = await protocolAndPayments(record);
  const existing = state.query;
  if (existing) return;
  if (!(await (await ethers.getContractAt("VeriArfyRegistry", record.contracts.VeriArfyRegistry)).isRegistered(signer.address))) {
    fail("deployer researcher registry'de kayitli degil");
  }
  const confirmedJournal = findConfirmedResearcherOpenJournal(state);
  if (confirmedJournal) {
    if (!confirmedJournal.expectedQueryId || !confirmedJournal.expectedRequestId) {
      fail(`researcher query journal idleri eksik: ${confirmedJournal.hash}`);
    }
    const recoveredQueryId = BigInt(confirmedJournal.expectedQueryId);
    const recoveredRequestId = BigInt(confirmedJournal.expectedRequestId);
    await assertQueryOpenedReceipt(payments, confirmedJournal, recoveredQueryId, recoveredRequestId, signer.address);
    const recovered = await payments.query(recoveredQueryId);
    await assertQueryBinding(recovered, protocol, payments, record, recoveredQueryId, recoveredRequestId, state);
    state.query = queryStateFromOnchain(recoveredQueryId, recovered, confirmedJournal);
    saveD17State(path, state);
    return;
  }
  const feeQuote = await payments.quoteForFields(QUERY_SNPS, []);
  const fee = asBigInt(feeQuote[0], "fee");
  const balance = await token.balanceOf(signer.address);
  if (balance < fee) fail(`tUSD yetersiz: ${balance} < ${fee}`);
  const allowance = await token.allowance(signer.address, await payments.getAddress());
  if (allowance < fee) await sendContract(state, path, "deployer", "researcher-token-approve", signer, token, "approve", [await payments.getAddress(), ethers.MaxUint256]);
  const queryId = asBigInt(await payments.nextQueryId(), "nextQueryId");
  const requestId = asBigInt(await protocol.nextRequestId(), "nextRequestId");
  const result = await sendContract(state, path, "deployer", "researcher-open-query", signer, payments, "openQueryFields", [QUERY_TYPE, QUERY_SNPS, []], undefined, { expectedQueryId: queryId.toString(), expectedRequestId: requestId.toString() });
  await assertQueryOpenedReceipt(payments, result.journal, queryId, requestId, signer.address);
  const query = await payments.query(queryId);
  await assertQueryBinding(query, protocol, payments, record, queryId, requestId, state);
  state.query = {
    queryId: queryId.toString(), requestId: requestId.toString(), queryType: QUERY_TYPE, snpIds: [...QUERY_SNPS],
    snapshotCount: Number(query.snapshotCount), fee: asBigInt(query.fee, "query.fee").toString(),
    openedAtBlock: Number(query.openedAtBlock), txs: [result.journal],
  };
  saveD17State(path, state);
  void protocol;
}

async function nodeStage(state: D17State, path: string, record: any, signer: any, nodeRole: "node-1" | "node-2"): Promise<void> {
  assertStateWriteAllowed(nodeRole);
  if (!state.query) fail("node stage icin researcher query state gerekli");
  const expected = nodeRole === "node-1" ? record.authorizedNodes[0] : record.authorizedNodes[1];
  if (!sameAddress(signer.address, expected)) fail(`${nodeRole} signer authorized node ile eslesmiyor`);
  const { protocol, payments, staking } = await protocolAndPayments(record);
  const key = addressKey(expected);
  state.nodes[nodeRole] ??= { address: getAddress(expected), txs: [] };
  const minStake = asBigInt(await staking.minStake(), "minStake");
  const current = asBigInt(await staking.stakeOf(expected), "stakeOf");
  if (current < minStake) {
    const result = await sendContract(state, path, nodeRole, "node-stake-topup", signer, staking, "stake", [], minStake - current);
    state.nodes[nodeRole].txs.push(result.journal);
  }
  state.nodes[nodeRole].stakeWei = (await staking.stakeOf(expected)).toString();
  state.nodes[nodeRole].minStakeWei = (await staking.minStake()).toString();
  if (await staking.isBanned(expected) || !(await staking.canApprove(expected))) fail(`${nodeRole} canApprove=false veya banned`);
  const requestId = BigInt(state.query.requestId);
  const queryId = BigInt(state.query.queryId);
  const query = await payments.query(queryId);
  await assertQueryBinding(query, protocol, payments, record, queryId, requestId, state);
  if (query.settled || query.refunded) fail("node approval query already closed");
  if (await protocol.isFailoverActive()) fail("node approval failover active");
  if (!(await protocol.hasApproved(requestId, expected))) {
    const result = await sendContract(state, path, nodeRole, "node-approve", signer, protocol, "approveDisclosure", [requestId]);
    state.nodes[nodeRole].txs.push(result.journal);
  }
  const disclosure = await protocol.disclosureRequest(requestId);
  const approvers = await protocol.disclosureApprovers(requestId);
  const requiredApprovers = nodeRole === "node-1" ? [record.authorizedNodes[0]] : [record.authorizedNodes[0], record.authorizedNodes[1]];
  if (Number(disclosure.approvals ?? disclosure[4]) !== requiredApprovers.length || Boolean(disclosure.finalized ?? disclosure[3]) !== (requiredApprovers.length === 2)) fail(`${nodeRole} disclosure approval count/finalized mismatch`);
  for (const node of requiredApprovers) if (!(await protocol.hasApproved(requestId, node))) fail(`${nodeRole} expected approval missing: ${node}`);
  if (approvers.length !== requiredApprovers.length || approvers.some((node: string, index: number) => !sameAddress(node, requiredApprovers[index]))) fail(`${nodeRole} foreign approval detected`);
  state.checks = { ...(state.checks ?? {}), [`${nodeRole}:approved`]: true, [`${nodeRole}:stake`]: state.nodes[nodeRole].stakeWei };
  saveD17State(path, state);
  void key;
}

async function settleStage(state: D17State, path: string, record: any, signer: any): Promise<void> {
  assertStateWriteAllowed("settle");
  if (role() !== "deployer" || !sameAddress(signer.address, record.deployer)) fail("settle yalniz deployer signer ile calisir");
  if (!state.query) fail("settle query state yok");
  const { protocol, payments, staking } = await protocolAndPayments(record);
  const requestId = BigInt(state.query.requestId);
  const queryId = BigInt(state.query.queryId);
  const boundQuery = await payments.query(queryId);
  await assertQueryBinding(boundQuery, protocol, payments, record, queryId, requestId, state);
  if (boundQuery.refunded) fail("settle query refunded");
  if (!(await protocol.isDisclosureGranted(requestId))) {
    const current = BigInt(await ethers.provider.getBlockNumber());
    const end = BigInt(await protocol.challengeWindowEnd(requestId));
    if (current < end) {
      state.checks = { ...(state.checks ?? {}), pendingChallengeUntil: end.toString(), pendingAtBlock: current.toString() };
      saveD17State(path, state);
      console.log(`D17_PENDING_WINDOW current=${current} end=${end}`);
      return;
    }
    if (await staking.isBlocked(requestId)) fail("challenge unresolved; execute durduruldu");
    const result = await sendContract(state, path, "deployer", "execute-disclosure", signer, protocol, "executeDisclosure", [requestId]);
    state.query.txs.push(result.journal);
  }
  if (!(await protocol.isDisclosureGranted(requestId))) fail("disclosure grant basarisiz");
  const query = await payments.query(queryId);
  if (!query.settled) {
    const result = await sendContract(state, path, "deployer", "settle-query", signer, payments, "settleQuery", [queryId]);
    state.query.txs.push(result.journal);
  }
  state.checks = { ...(state.checks ?? {}), disclosureGranted: true, settled: true };
  saveD17State(path, state);
}

async function claimStage(state: D17State, path: string, record: any, signer: any): Promise<void> {
  assertStateWriteAllowed("claim");
  if (!state.query) fail("claim query state yok");
  const { protocol, payments, token } = await protocolAndPayments(record);
  const address = role() === "deployer" ? getAddress(record.deployer) : roleParticipantAddress(state, role());
  if (!sameAddress(signer.address, address)) fail("claim signer role adresi ile eslesmiyor");
  const queryId = BigInt(state.query.queryId);
  const query = await payments.query(queryId);
  await assertQueryBinding(query, protocol, payments, record, queryId, BigInt(state.query.requestId), state);
  if (!query.settled) fail("claim oncesi query settled degil");
  if (await payments.hasClaimed(queryId, address)) {
    if (!state.claims[addressKey(address)]) {
      const journal = state.txs.find((item) => item.kind === "claim" && sameAddress(item.from, address) && item.status === "confirmed");
      if (!journal) fail(`claim zincirde var ancak state kaniti yok: ${address}`);
      const receipt = await ethers.provider.getTransactionReceipt(journal.hash);
      if (!receipt) fail(`claim receipt okunamadi: ${journal.hash}`);
      let amount: bigint | undefined;
      for (const log of receipt.logs) {
        try {
          const parsed = payments.interface.parseLog(log);
          if (parsed?.name === "RewardClaimed" && sameAddress(parsed.args.participant, address) && asBigInt(parsed.args.queryId, "claim query id") === queryId) {
            amount = asBigInt(parsed.args.amount, "claim amount");
            break;
          }
        } catch { /* a log from another contract */ }
      }
      if (amount === undefined) fail(`claim event bulunamadi: ${journal.hash}`);
      state.claims[addressKey(address)] = { amount: amount.toString(), tx: journal };
      saveD17State(path, state);
    }
    return;
  }
  const amount = asBigInt(await payments.claimable(queryId, address), "claimable");
  if (amount === 0n) fail(`${role()} entitled claimable sifir`);
  const before = asBigInt(await token.balanceOf(address), "tokenBefore");
  const result = await sendContract(state, path, role(), "claim", signer, payments, "claim", [queryId]);
  const after = asBigInt(await token.balanceOf(address), "tokenAfter");
  if (after - before !== amount) fail(`claim amount mismatch: ${after - before} != ${amount}`);
  state.claims[addressKey(address)] = { amount: amount.toString(), tx: result.journal };
  saveD17State(path, state);
}

async function claimEventAmount(payments: AnyContract, journal: D17Tx, queryId: bigint, address: string): Promise<bigint> {
  if (journal.status !== "confirmed") fail(`claim receipt confirmed degil: ${journal.hash}`);
  const receipt = await ethers.provider.getTransactionReceipt(journal.hash);
  if (!receipt) fail(`claim receipt okunamadi: ${journal.hash}`);
  for (const log of receipt.logs) {
    try {
      const parsed = payments.interface.parseLog(log);
      if (parsed?.name === "RewardClaimed" && sameAddress(parsed.args.participant, address) && asBigInt(parsed.args.queryId, "claim query id") === queryId) {
        return asBigInt(parsed.args.amount, "claim amount");
      }
    } catch { /* a log from another contract */ }
  }
  fail(`RewardClaimed event bulunamadi: ${journal.hash}`);
}

async function reportStage(state: D17State, path: string, record: any): Promise<void> {
  if (!state.baseline || !state.query) fail("report baseline/query eksik");
  const { protocol, payments } = await protocolAndPayments(record);
  const baseline = state.baseline;
  const verifiedBaseline = await captureBaseline(protocol, record, baseline.capturedAtBlock);
  if (!verifiedBaseline) fail("baseline zincir snapshot'i okunamadi");
  const normalize = (addresses: string[]) => addresses.map((address) => getAddress(address).toLowerCase());
  if (verifiedBaseline.participantCount !== baseline.participantCount ||
      verifiedBaseline.coverage["0"] !== baseline.coverage["0"] ||
      verifiedBaseline.coverage["1"] !== baseline.coverage["1"] ||
      verifiedBaseline.rareCarrierCount !== baseline.rareCarrierCount ||
      JSON.stringify(normalize(verifiedBaseline.participants)) !== JSON.stringify(normalize(baseline.participants))) {
    fail("baseline snapshot state ile zincir verisi uyusmuyor");
  }
  const newParticipants = participantAddresses(state);
  const queryId = BigInt(state.query.queryId);
  const query = await payments.query(queryId);
  await assertQueryBinding(query, protocol, payments, record, queryId, BigInt(state.query.requestId), state);
  const snapshotCount = Number(query.snapshotCount);
  const snapshotParticipants = await baselineParticipants(protocol, record, Number(query.openedAtBlock), snapshotCount);
  const addresses = [...verifiedBaseline.participants, ...newParticipants];
  const unique = addresses.filter((address, index) => addresses.findIndex((item) => sameAddress(item, address)) === index);
  const expectedSnapshot = new Set(normalize(unique));
  const actualSnapshot = new Set(normalize(snapshotParticipants));
  if (expectedSnapshot.size !== snapshotCount || actualSnapshot.size !== snapshotCount ||
      expectedSnapshot.size !== actualSnapshot.size || [...expectedSnapshot].some((address) => !actualSnapshot.has(address))) {
    fail("query snapshot katilimci seti baseline/cohort ile uyusmuyor");
  }
  const count = Number(await protocol.participantCount());
  const expectedCount = verifiedBaseline.participantCount + newParticipants.length;
  if (count !== expectedCount) fail(`participant delta mismatch: ${count} != ${expectedCount}`);
  const coverage0 = asBigInt(await protocol.snpCoverageCount(0), "coverage0");
  const coverage1 = asBigInt(await protocol.snpCoverageCount(1), "coverage1");
  const expected0 = BigInt(verifiedBaseline.coverage["0"]) + BigInt(newParticipants.length);
  const expected1 = BigInt(verifiedBaseline.coverage["1"]) + 1n;
  if (coverage0 !== expected0 || coverage1 !== expected1) fail(`coverage delta mismatch: [${coverage0},${coverage1}] != [${expected0},${expected1}]`);
  const rare = Number(await protocol.rareCarrierCount());
  if (rare !== verifiedBaseline.rareCarrierCount + 1) fail(`rare carrier delta mismatch: ${rare}`);
  if (Number(query.snapshotCount) !== expectedCount) fail("query snapshot count final participant count ile eslesmiyor");
  if (BigInt(query.coverageTotal) !== coverage0 + coverage1) fail("query coverageTotal mismatch");
  const weightedTotal = asBigInt(await payments.weightedTotal(queryId), "weightedTotal");
  let weightedSum = 0n;
  let totalWeight = 0n;
  for (const address of unique) {
    weightedSum += asBigInt(await payments.weightedCoverage(queryId, address), "weightedCoverage");
    totalWeight += asBigInt(await payments.weightOf(queryId, address), "weightOf");
  }
  const queryWeights = await payments.queryWeights(queryId);
  if (weightedSum !== weightedTotal) fail(`weighted coverage conservation mismatch: ${weightedSum} != ${weightedTotal}`);
  if (totalWeight !== asBigInt(queryWeights[3], "query total weight")) fail("weight conservation mismatch");
  const first = state.participants[addressKey(participantAddresses(state)[0])];
  const second = state.participants[addressKey(participantAddresses(state)[1])];
  if (!first || !second || asBigInt(await payments.coverageWeight(queryId, first.address), "first coverage") <= asBigInt(await payments.coverageWeight(queryId, second.address), "second coverage")) fail("rare participant coverage weight üstün degil");
  if (!query.settled || !await protocol.isDisclosureGranted(BigInt(state.query.requestId))) fail("query tamamlanmamis");
  let claimed = 0n;
  for (const address of unique) {
    const item = state.claims[addressKey(address)];
    if (!item) fail(`claim eksik: ${address}`);
    if (!(await payments.hasClaimed(queryId, address))) fail(`claim zincirde gorunmuyor: ${address}`);
    if (!item.tx) fail(`claim tx state'de eksik: ${address}`);
    const emitted = await claimEventAmount(payments, item.tx, queryId, address);
    if (emitted !== BigInt(item.amount)) fail(`claim evidence amount mismatch: ${address}`);
    claimed += emitted;
  }
  if (claimed !== BigInt(query.claimedTotal) || claimed > BigInt(query.liquidityPot)) fail("claim conservation mismatch");
  const proofChecks = participantAddresses(state).every((address) => state.checks?.[`${state.participants[addressKey(address)].role}:proof`] === true && state.checks?.[`${state.participants[addressKey(address)].role}:alteredSignalRejected`] === true);
  if (!proofChecks) fail("proof positive/altered-signal checks incomplete");
  state.checks = { ...(state.checks ?? {}), final: true, finalCount: count, coverage0: coverage0.toString(), coverage1: coverage1.toString(), weightedTotal: weightedTotal.toString(), claimedTotal: claimed.toString() };
  saveD17State(path, state);
  console.log(JSON.stringify({ final: true, participantCount: count, coverage: [coverage0.toString(), coverage1.toString()], weightedTotal: weightedTotal.toString(), claimedTotal: claimed.toString(), queryId: state.query.queryId }, null, 2));
}

async function preflight(state: D17State, record: any): Promise<void> {
  const { protocol, staking, payments } = await protocolAndPayments(record);
  const snpCount = Number(await protocol.snpCount());
  if (snpCount !== PANEL_SNP_COUNT || Number(await protocol.rareSnpIndex()) !== 0) fail("D17 panel parametreleri 10 SNP/rare index 0 degil");
  if (Number(await protocol.requiredApprovals(QUERY_TYPE)) !== 2) fail("query type 2 requiredApprovals != 2");
  const minParticipants = Number(await protocol.minParticipants());
  const current = Number(await protocol.participantCount());
  if (current + participantAddresses(state).length < minParticipants) fail("minParticipants saglanamiyor");
  for (const node of record.authorizedNodes) {
    if (await protocol.isAuthorizedNode(node) !== true || await staking.isBanned(node)) fail(`node topology gecersiz: ${node}`);
  }
  const quote = await payments.quoteForFields(QUERY_SNPS, []);
  console.log(JSON.stringify({ network: network.name, chainId: CHAIN_ID.toString(), participantCount: current, minParticipants, snpCount, quoteFee: asBigInt(quote[0], "quote fee").toString(), quoteRecords: asBigInt(quote[1], "quote records").toString(), nodes: record.authorizedNodes }, null, 2));
}

export async function main(): Promise<void> {
  await assertSepolia();
  const record = deploymentRecord();
  await assertDeploymentIntegrity(record);
  const currentStage = stage();
  const path = stateFile();
  const state = loadD17State(path);
  state.deployment = {
    protocol: record.contracts.VeriarfyProtocol,
    payments: record.contracts.VeriarfyPayments,
    staking: record.contracts.VeriarfyStaking,
    token: record.contracts.PaymentToken,
  };
  if (currentStage === "preflight") {
    await preflight(state, record);
    return;
  }
  if (currentStage === "init") {
    await withD17StateLockAsync(path, async () => {
      const current = loadD17State(path);
      current.deployment = {
        protocol: record.contracts.VeriarfyProtocol,
        payments: record.contracts.VeriarfyPayments,
        staking: record.contracts.VeriarfyStaking,
        token: record.contracts.PaymentToken,
      };
      const addresses = parseAddresses(process.env.D17_PARTICIPANTS);
      ensureParticipantState(current, addresses);
      const { protocol } = await protocolAndPayments(record);
      if (!current.baseline) current.baseline = await captureBaseline(protocol, record);
      const baseline = current.baseline;
      if (!baseline) fail("baseline yakalanamadi");
      saveD17State(path, current);
      console.log(`D17 init baseline=${baseline.participantCount} participants=${addresses.length}`);
    });
    return;
  }
  const requiresSigner = ["fund", "participant", "researcher", "node-1", "node-2", "settle", "claim"].includes(currentStage);
  const signer = await oneSigner(requiresSigner);
  if (requiresSigner && !signer) fail(`${currentStage} signer yok`);
  const roleName = role();
  if (currentStage === "fund") {
    await withD17StateLockAsync(path, async () => { const current = loadD17State(path); await reconcilePending(current, path); await fundStage(current, path, record, signer); });
    return;
  }
  if (currentStage === "participant") {
    await withD17StateLockAsync(path, async () => { const current = loadD17State(path); await reconcilePending(current, path); await participantStage(current, path, record, signer, roleName); });
    return;
  }
  if (currentStage === "researcher") {
    await withD17StateLockAsync(path, async () => { const current = loadD17State(path); await reconcilePending(current, path); await researcherStage(current, path, record, signer); });
    return;
  }
  if (currentStage === "node-1" || currentStage === "node-2") {
    await withD17StateLockAsync(path, async () => { const current = loadD17State(path); await reconcilePending(current, path); await nodeStage(current, path, record, signer, currentStage); });
    return;
  }
  if (currentStage === "settle") {
    await withD17StateLockAsync(path, async () => { const current = loadD17State(path); await reconcilePending(current, path); await settleStage(current, path, record, signer); });
    return;
  }
  if (currentStage === "claim") {
    await withD17StateLockAsync(path, async () => { const current = loadD17State(path); await reconcilePending(current, path); await claimStage(current, path, record, signer); });
    return;
  }
  if (currentStage === "report") {
    await withD17StateLockAsync(path, async () => { const current = loadD17State(path); await reconcilePending(current, path); await reportStage(current, path, record); });
    return;
  }
  fail(`bilinmeyen D17_STAGE: ${currentStage}`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((error: unknown) => {
    console.error(`D17 BASARISIZ: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
