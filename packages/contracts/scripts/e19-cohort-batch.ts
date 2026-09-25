/** Sequential, resumable real-FHE execution for a bounded E/19 cohort range. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "ethers";
import { ethers, fhevm, network } from "hardhat";
import { E19_CLINICAL_POLICY } from "@veriarfy/study";

const ACK = "e19-synthetic-cohort";
const PROFILE = "e19-synthetic-cyp2c19-clopidogrel-v1";
const FUND_PER_PARTICIPANT = ethers.parseEther("0.003");
const MAX_FEE = ethers.parseUnits("2", "gwei");
const PRIORITY_FEE = ethers.parseUnits("0.1", "gwei");
const MAX_GAS = 6_000_000n;

type Row = { index: number; group: 0 | 1; response: 0 | 1; address: string; privateKey: string };

function fail(message: string): never { throw new Error(`E19 cohort batch: ${message}`); }

function inputRange() {
  if (process.env.E19_COHORT_ACK !== ACK || process.env.E19_COHORT_BATCH !== "1") {
    fail(`E19_COHORT_ACK=${ACK} ve E19_COHORT_BATCH=1 olmadan batch zincir islemi yasak`);
  }
  const start = Number(process.env.E19_BATCH_START);
  const end = Number(process.env.E19_BATCH_END);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 59 || start > end) {
    fail("E19_BATCH_START/E19_BATCH_END 0..59 araliginda olmali");
  }
  return { start, end };
}

function vault(): Row[] {
  const home = process.env.USERPROFILE;
  if (!home) fail("USERPROFILE bulunamadi; FarukOS kasasi yolu belirlenemiyor");
  let value: { schema?: string; profile?: string; syntheticOnly?: boolean; participants?: Row[] };
  try { value = JSON.parse(readFileSync(join(home, "FarukOS", "🔐 400-Vault", "VeriArfy", "e19-synthetic-cohort.json"), "utf8")); } catch { fail("FarukOS cohort kasasi okunamadi"); }
  if (value.schema !== "veriarfy.e19.synthetic-cohort.v1" || value.profile !== PROFILE || value.syntheticOnly !== true || value.participants?.length !== 60) {
    fail("FarukOS cohort kasasi gecersiz");
  }
  for (const row of value.participants) {
    if (!Number.isInteger(row.index) || row.index < 0 || row.index > 59 || !ethers.isAddress(row.address) || !/^(0x)?[0-9a-fA-F]{64}$/.test(row.privateKey) || (row.group !== 0 && row.group !== 1) || (row.response !== 0 && row.response !== 1)) {
      fail("FarukOS cohort satiri gecersiz");
    }
  }
  return value.participants;
}

function deployment(): any {
  let value: any;
  try { value = JSON.parse(readFileSync(join(__dirname, "..", "deployments", "e19-sepolia.json"), "utf8")); } catch { fail("E19 deployment kaydi okunamadi"); }
  const names = ["VeriarfyProtocolE19", "VeriarfyClinical", "VeriarfyClinicalAggregate"];
  if (value.profile !== PROFILE || value.network !== "sepolia" || value.chainId !== 11155111 || !ethers.isAddress(value.deployer) || names.some((name) => !ethers.isAddress(value.contracts?.[name]))) fail("E19 deployment kaydi gecersiz");
  return value;
}

async function fee() {
  const latest = await ethers.provider.getBlock("latest");
  if ((latest?.baseFeePerGas ?? 0n) + PRIORITY_FEE > MAX_FEE) fail("Sepolia base fee gas tavanini asti; yeniden dene");
  return { maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: PRIORITY_FEE };
}

async function requireBudget(label: string, address: string, estimate: bigint) {
  if (estimate > MAX_GAS) fail(`${label} gas tavanini asti: ${estimate}`);
  const required = estimate * 12n / 10n * MAX_FEE;
  if (await ethers.provider.getBalance(address) < required) fail(`${label} icin participant bakiyesi yetersiz`);
}

async function send(label: string, txFactory: () => Promise<any>) {
  const tx = await txFactory();
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) fail(`${label} basarisiz`);
  // Public Sepolia RPC'leri bazen yeni mined nonce'u saniyelerce farkli
  // mempool gorunumlerinde tasir; bir sonraki tx'i bu pencereye sokma.
  await new Promise((resolve) => setTimeout(resolve, 2500));
  return { hash: tx.hash, gasUsed: receipt.gasUsed.toString() };
}

async function runParticipant(row: Row, record: any, options: Awaited<ReturnType<typeof fee>>) {
  const signer = new Wallet(row.privateKey, ethers.provider);
  if (signer.address.toLowerCase() !== row.address.toLowerCase()) fail(`participant ${row.index} private key/adres uyusmuyor`);
  const [protocol, clinical, aggregate] = await Promise.all([
    ethers.getContractAt("VeriarfyProtocolE19", record.contracts.VeriarfyProtocolE19, signer),
    ethers.getContractAt("VeriarfyClinical", record.contracts.VeriarfyClinical, signer),
    ethers.getContractAt("VeriarfyClinicalAggregate", record.contracts.VeriarfyClinicalAggregate, signer),
  ]);
  const actions: Record<string, string> = {};
  if (!(await protocol.isEnrolled(signer.address))) {
    const encrypted = await fhevm.createEncryptedInput(record.contracts.VeriarfyProtocolE19, signer.address).add8(row.group).encrypt();
    const estimate = await protocol.enroll.estimateGas(encrypted.handles[0], encrypted.inputProof, options);
    await requireBudget("enroll", signer.address, estimate);
    actions.enroll = (await send("enroll", () => protocol.enroll(encrypted.handles[0], encrypted.inputProof, { ...options, gasLimit: estimate * 12n / 10n }))).hash;
  }
  if ((await clinical.consentOf(signer.address)).acceptedAt === 0n) {
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) fail("latest block okunamadi");
    const expiresAt = BigInt(latest.timestamp) + 180n * 24n * 60n * 60n;
    const estimate = await clinical.acceptConsent.estimateGas(ethers.id(E19_CLINICAL_POLICY.panelId), ethers.id(E19_CLINICAL_POLICY.purposeId), ethers.id(E19_CLINICAL_POLICY.consentVersion), ethers.id(E19_CLINICAL_POLICY.consentDocumentId), expiresAt, options);
    await requireBudget("accept-consent", signer.address, estimate);
    actions.consent = (await send("accept-consent", () => clinical.acceptConsent(ethers.id(E19_CLINICAL_POLICY.panelId), ethers.id(E19_CLINICAL_POLICY.purposeId), ethers.id(E19_CLINICAL_POLICY.consentVersion), ethers.id(E19_CLINICAL_POLICY.consentDocumentId), expiresAt, { ...options, gasLimit: estimate * 12n / 10n }))).hash;
  }
  if (!(await aggregate.contributed(signer.address))) {
    const encrypted = await fhevm.createEncryptedInput(record.contracts.VeriarfyClinicalAggregate, signer.address).add8(row.response).encrypt();
    const estimate = await aggregate.contributeResponses.estimateGas(encrypted.handles, encrypted.inputProof, options);
    await requireBudget("contribute-response", signer.address, estimate);
    actions.response = (await send("contribute-response", () => aggregate.contributeResponses(encrypted.handles, encrypted.inputProof, { ...options, gasLimit: estimate * 12n / 10n }))).hash;
  }
  if (!(await aggregate.contributed(signer.address))) fail(`participant ${row.index} klinik katkisi zincirde yok`);
  return actions;
}

async function main() {
  if (network.name !== "sepolia" || (await ethers.provider.getNetwork()).chainId !== 11155111n) fail("yalniz Sepolia kabul edilir");
  const { start, end } = inputRange();
  const rows = vault();
  const record = deployment();
  const [deployer, ...extra] = await ethers.getSigners();
  if (extra.length || deployer.address.toLowerCase() !== record.deployer.toLowerCase()) fail("yalniz izole E19 deployer kabul edilir");
  await fhevm.initializeCLIApi();
  await fhevm.assertCoprocessorInitialized(record.contracts.VeriarfyProtocolE19, "VeriarfyProtocolE19");
  await fhevm.assertCoprocessorInitialized(record.contracts.VeriarfyClinicalAggregate, "VeriarfyClinicalAggregate");
  const [protocol, aggregate, options] = await Promise.all([
    ethers.getContractAt("VeriarfyProtocolE19", record.contracts.VeriarfyProtocolE19),
    ethers.getContractAt("VeriarfyClinicalAggregate", record.contracts.VeriarfyClinicalAggregate),
    fee(),
  ]);
  if ((await protocol.MIN_PARTICIPANTS()) !== 60n || (await aggregate.endpointCount()) !== 1n) fail("canli E19 profile bekleneni vermiyor");

  for (let index = start; index <= end; index++) {
    const row = rows[index];
    const current = await ethers.provider.getBalance(row.address);
    let fundingHash: string | undefined;
    if (current < FUND_PER_PARTICIPANT) {
      const source = await ethers.provider.getBalance(deployer.address);
      const value = FUND_PER_PARTICIPANT - current;
      if (source < value + ethers.parseEther("0.01")) fail(`participant ${index} icin deployer rezervi yetersiz`);
      const funded = await send("fund-participant", () => deployer.sendTransaction({ to: row.address, value, ...options }));
      fundingHash = funded.hash;
    }
    const actions = await runParticipant(row, record, options);
    console.log(JSON.stringify({ pass: true, participant: index, fundingHash, actions, participantCount: (await protocol.participantCount()).toString() }));
  }
  console.log(JSON.stringify({ pass: true, completeRange: [start, end], participantCount: (await protocol.participantCount()).toString() }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
