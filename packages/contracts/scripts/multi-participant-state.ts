import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Public, resumable D/17 state. Secrets, witnesses and signed transactions are forbidden. */
export type D17Tx = {
  kind: string;
  role: string;
  from: string;
  to?: string;
  hash: string;
  nonce?: number;
  valueWei?: string;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  expectedQueryId?: string;
  expectedRequestId?: string;
  gasUsed?: string;
  effectiveGasPriceWei?: string;
  blockNumber?: number;
  status: "prepared" | "broadcast" | "confirmed";
};

export type D17Participant = {
  role: string;
  address: string;
  coverage: number[];
  cidDigest?: string;
  commitment?: string;
  recordSubmitted?: boolean;
  enrolled?: boolean;
  submittedSnps?: number;
  rarityRequested?: boolean;
  rarityConfirmed?: boolean;
  isRare?: boolean;
  txs: D17Tx[];
};

export type D17State = {
  version: 1;
  profile: "d17-sepolia-multi-participant-v1";
  network: "sepolia";
  chainId: 11155111;
  deployment?: { protocol: string; payments: string; staking: string; token: string };
  participants: Record<string, D17Participant>;
  baseline?: {
    capturedAtBlock: number;
    participantCount: number;
    coverage: Record<string, string>;
    rareCarrierCount: number;
    participants: string[];
  };
  query?: {
    queryId: string;
    requestId: string;
    queryType: number;
    snpIds: number[];
    snapshotCount: number;
    fee: string;
    openedAtBlock: number;
    txs: D17Tx[];
  };
  nodes: Record<string, { address: string; stakeWei?: string; minStakeWei?: string; txs: D17Tx[] }>;
  claims: Record<string, { amount: string; tx?: D17Tx }>;
  txs: D17Tx[];
  checks?: Record<string, unknown>;
};

export function emptyD17State(): D17State {
  return {
    version: 1,
    profile: "d17-sepolia-multi-participant-v1",
    network: "sepolia",
    chainId: 11155111,
    participants: {},
    nodes: {},
    claims: {},
    txs: [],
  };
}

function statePath(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("D17_STATE_PATH bos olamaz");
  return value;
}

export function loadD17State(path: string): D17State {
  const file = statePath(path);
  if (!existsSync(file)) return emptyD17State();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`D17 state okunamadi: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("D17 state object olmali");
  }
  const state = parsed as Partial<D17State>;
  if (state.version !== 1 || state.profile !== "d17-sepolia-multi-participant-v1") {
    throw new Error("D17 state profile/version uyusmuyor");
  }
  if (state.network !== "sepolia" || state.chainId !== 11155111) {
    throw new Error("D17 state yalniz Sepolia chainId 11155111 icindir");
  }
  if (!state.participants || !state.nodes || !state.claims || !state.txs) {
    throw new Error("D17 state public alanlari eksik");
  }
  validateD17State(state as D17State);
  return state as D17State;
}

export function saveD17State(path: string, state: D17State): void {
  validateD17State(state);
  const file = statePath(path);
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${file.split(/[\\/]/).pop()}.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temp, file);
}

function address(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`D17 state ${field} adresi gecersiz`);
}

function decimal(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`D17 state ${field} decimal olmali`);
}

function hash(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`D17 state ${field} hash olmali`);
}

function publicOnly(value: unknown, path: string): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => publicOnly(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/private|secret|witness|salt|raw.?signed|signed.?tx/i.test(key)) {
      throw new Error(`D17 state secret/raw transaction field yasak: ${path}.${key}`);
    }
    publicOnly(child, `${path}.${key}`);
  }
}

function validateTx(tx: D17Tx, field: string): void {
  if (!tx || typeof tx !== "object") throw new Error(`D17 state ${field} tx object olmali`);
  if (typeof tx.kind !== "string" || typeof tx.role !== "string") throw new Error(`D17 state ${field} tx kimligi eksik`);
  address(tx.from, `${field}.from`);
  if (tx.to !== undefined) address(tx.to, `${field}.to`);
  hash(tx.hash, `${field}.hash`);
  const nonce = tx.nonce;
  if (nonce === undefined || !Number.isInteger(nonce) || Number(nonce) < 0) throw new Error(`D17 state ${field}.nonce gecersiz`);
  if (tx.status !== "prepared" && tx.status !== "broadcast" && tx.status !== "confirmed") throw new Error(`D17 state ${field}.status gecersiz`);
  for (const key of ["valueWei", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "gasUsed", "effectiveGasPriceWei", "expectedQueryId", "expectedRequestId"]) {
    const value = tx[key as keyof D17Tx];
    if (value !== undefined) decimal(value, `${field}.${key}`);
  }
}

function validateD17State(state: D17State): void {
  publicOnly(state, "state");
  if (state.version !== 1 || state.profile !== "d17-sepolia-multi-participant-v1" || state.network !== "sepolia" || state.chainId !== 11155111) {
    throw new Error("D17 state profile/version/network gecersiz");
  }
  if (state.deployment) {
    for (const [name, value] of Object.entries(state.deployment)) address(value, `deployment.${name}`);
  }
  for (const [key, participant] of Object.entries(state.participants ?? {})) {
    address(participant.address, `participants.${key}.address`);
    if (!Array.isArray(participant.coverage) || participant.coverage.some((item) => !Number.isInteger(item) || item < 0 || item >= 10)) throw new Error(`D17 state participants.${key}.coverage gecersiz`);
    if (!Array.isArray(participant.txs)) throw new Error(`D17 state participants.${key}.txs eksik`);
    participant.txs.forEach((tx, index) => validateTx(tx, `participants.${key}.txs[${index}]`));
    if (participant.cidDigest !== undefined) hash(participant.cidDigest, `participants.${key}.cidDigest`);
    if (participant.commitment !== undefined) hash(participant.commitment, `participants.${key}.commitment`);
  }
  (state.txs ?? []).forEach((tx, index) => validateTx(tx, `txs[${index}]`));
  for (const [key, claim] of Object.entries(state.claims ?? {})) {
    address(`0x${key.replace(/^0x/, "")}`, `claims.${key}`);
    decimal(claim.amount, `claims.${key}.amount`);
    if (claim.tx) validateTx(claim.tx, `claims.${key}.tx`);
  }
  for (const [role, node] of Object.entries(state.nodes ?? {})) {
    address(node.address, `nodes.${role}.address`);
    if (node.stakeWei !== undefined) decimal(node.stakeWei, `nodes.${role}.stakeWei`);
    if (node.minStakeWei !== undefined) decimal(node.minStakeWei, `nodes.${role}.minStakeWei`);
    if (!Array.isArray(node.txs)) throw new Error(`D17 state nodes.${role}.txs eksik`);
    node.txs.forEach((tx, index) => validateTx(tx, `nodes.${role}.txs[${index}]`));
  }
  if (state.baseline) {
    if (!Number.isInteger(state.baseline.capturedAtBlock) || state.baseline.capturedAtBlock < 0 || !Number.isInteger(state.baseline.participantCount) || state.baseline.participantCount < 0 || !Number.isInteger(state.baseline.rareCarrierCount) || state.baseline.rareCarrierCount < 0) throw new Error("D17 state baseline counters gecersiz");
    for (const item of state.baseline.participants) address(item, "baseline.participant");
    decimal(state.baseline.coverage["0"], "baseline.coverage.0");
    decimal(state.baseline.coverage["1"], "baseline.coverage.1");
  }
  if (state.query) {
    decimal(state.query.queryId, "query.queryId");
    decimal(state.query.requestId, "query.requestId");
    if (state.query.queryType !== 2) throw new Error("D17 state query.queryType 2 olmali");
    decimal(state.query.fee, "query.fee");
    if (!Array.isArray(state.query.snpIds) || state.query.snpIds.some((item) => !Number.isInteger(item) || item < 0 || item >= 10)) throw new Error("D17 state query.snpIds gecersiz");
    state.query.txs.forEach((tx, index) => validateTx(tx, `query.txs[${index}]`));
  }
}

/** Serialize all writers. The lock is deliberately separate from the JSON. */
export function withD17StateLock<T>(path: string, fn: () => T): T {
  const file = statePath(path);
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let fd: number;
  try {
    fd = openSync(lock, "wx");
    writeFileSync(fd, `${process.pid}\n`, "utf8");
  } catch {
    throw new Error(`D17 state lock mevcut: ${lock}`);
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(lock); } catch { /* already cleaned by an operator */ }
  }
}

export async function withD17StateLockAsync<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const file = statePath(path);
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let fd: number;
  try {
    fd = openSync(lock, "wx");
    writeFileSync(fd, `${process.pid}\n`, "utf8");
  } catch {
    throw new Error(`D17 state lock mevcut: ${lock}`);
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(lock); } catch { /* already cleaned by an operator */ }
  }
}

export function recordTx(state: D17State, tx: D17Tx): void {
  if (!tx.hash || !/^0x[0-9a-fA-F]{64}$/.test(tx.hash)) {
    throw new Error("D17 state yalniz gecerli transaction hash saklar");
  }
  state.txs.push(tx);
}

export function txFor(state: D17State, kind: string, role: string): D17Tx | undefined {
  return state.txs.find((tx) => tx.kind === kind && tx.role === role && tx.status === "confirmed");
}
