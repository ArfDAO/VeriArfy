/**
 * Run exactly one synthetic E/19 participant's encrypted enrollment, consent,
 * and fixed-panel response contribution. Keys live only in FarukOS vault.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, fhevm, network } from "hardhat";
import { Wallet } from "ethers";
import { E19_CLINICAL_POLICY } from "@veriarfy/study";

const ACK = "e19-synthetic-cohort";
const PROFILE = "e19-synthetic-cyp2c19-clopidogrel-v1";
const MAX_FEE = ethers.parseUnits("2", "gwei");
const PRIORITY_FEE = ethers.parseUnits("0.1", "gwei");
const MAX_GAS = 6_000_000n;

type Row = { index: number; group: 0 | 1; response: 0 | 1; address: string; privateKey: string };

function fail(message: string): never { throw new Error(`E19 participant: ${message}`); }

function selectedRow(): Row {
  if (process.env.E19_COHORT_ACK !== ACK || process.env.E19_COHORT_EXECUTE !== "1") {
    fail(`E19_COHORT_ACK=${ACK} ve E19_COHORT_EXECUTE=1 olmadan zincir islemi yasak`);
  }
  const index = Number(process.env.E19_PARTICIPANT_INDEX);
  if (!Number.isInteger(index) || index < 0 || index >= 60) fail("E19_PARTICIPANT_INDEX 0..59 olmali");
  const home = process.env.USERPROFILE;
  if (!home) fail("USERPROFILE bulunamadi; FarukOS kasasi yolu belirlenemiyor");
  const path = join(home, "FarukOS", "🔐 400-Vault", "VeriArfy", "e19-synthetic-cohort.json");
  let vault: { schema?: string; profile?: string; syntheticOnly?: boolean; participants?: Row[] };
  try { vault = JSON.parse(readFileSync(path, "utf8")); } catch { fail("FarukOS cohort kasasi okunamadi"); }
  const row = vault.participants?.[index];
  if (
    vault.schema !== "veriarfy.e19.synthetic-cohort.v1" || vault.profile !== PROFILE || vault.syntheticOnly !== true || !row ||
    row.index !== index || !ethers.isAddress(row.address) || !/^(0x)?[0-9a-fA-F]{64}$/.test(row.privateKey) ||
    (row.group !== 0 && row.group !== 1) || (row.response !== 0 && row.response !== 1)
  ) fail("FarukOS cohort satiri gecersiz");
  return row;
}

function deployment(): any {
  const path = join(__dirname, "..", "deployments", "e19-sepolia.json");
  let value: any;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { fail("E19 deployment kaydi okunamadi"); }
  const names = ["VeriarfyProtocolE19", "VeriarfyClinical", "VeriarfyClinicalAggregate"];
  if (value.profile !== PROFILE || value.network !== "sepolia" || value.chainId !== 11155111 || value.syntheticOnly !== true || names.some((name) => !ethers.isAddress(value.contracts?.[name]))) {
    fail("E19 deployment kaydi gecersiz");
  }
  return value;
}

async function feeOverrides() {
  const latest = await ethers.provider.getBlock("latest");
  if ((latest?.baseFeePerGas ?? 0n) + PRIORITY_FEE > MAX_FEE) fail("Sepolia base fee gas tavanini asti; yeniden dene");
  return { maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: PRIORITY_FEE };
}

async function requireBudget(label: string, signer: string, estimate: bigint) {
  if (estimate > MAX_GAS) fail(`${label} gas tavanini asti: ${estimate}`);
  const required = estimate * 12n / 10n * MAX_FEE;
  const balance = await ethers.provider.getBalance(signer);
  if (balance < required) {
    console.log(JSON.stringify({ pass: false, label, balanceSepETH: ethers.formatEther(balance), requiredSepETH: ethers.formatEther(required), estimate: estimate.toString() }));
    fail(`${label} icin bakiye yetersiz; transaction gonderilmedi`);
  }
}

async function send(label: string, txFactory: () => Promise<any>) {
  const tx = await txFactory();
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) fail(`${label} basarisiz`);
  console.log(JSON.stringify({ label, hash: tx.hash, nonce: tx.nonce, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber }));
}

async function main() {
  if (network.name !== "sepolia" || (await ethers.provider.getNetwork()).chainId !== 11155111n) fail("yalniz Sepolia kabul edilir");
  const row = selectedRow();
  const record = deployment();
  const signer = new Wallet(row.privateKey, ethers.provider);
  if (signer.address.toLowerCase() !== row.address.toLowerCase()) fail("FarukOS private key/adres uyusmuyor");
  const [protocol, clinical, aggregate] = await Promise.all([
    ethers.getContractAt("VeriarfyProtocolE19", record.contracts.VeriarfyProtocolE19, signer),
    ethers.getContractAt("VeriarfyClinical", record.contracts.VeriarfyClinical, signer),
    ethers.getContractAt("VeriarfyClinicalAggregate", record.contracts.VeriarfyClinicalAggregate, signer),
  ]);
  const [minimum, endpointCount, policy] = await Promise.all([protocol.MIN_PARTICIPANTS(), aggregate.endpointCount(), clinical.policy()]);
  if (minimum !== 60n || endpointCount !== 1n || policy.panelId !== ethers.id(E19_CLINICAL_POLICY.panelId) || policy.purposeId !== ethers.id(E19_CLINICAL_POLICY.purposeId)) {
    fail("canli E19 politikasi/panel bekleneni vermiyor");
  }
  await fhevm.initializeCLIApi();
  await fhevm.assertCoprocessorInitialized(record.contracts.VeriarfyProtocolE19, "VeriarfyProtocolE19");
  await fhevm.assertCoprocessorInitialized(record.contracts.VeriarfyClinicalAggregate, "VeriarfyClinicalAggregate");
  const fee = await feeOverrides();

  if (!(await protocol.isEnrolled(signer.address))) {
    const encrypted = await fhevm.createEncryptedInput(record.contracts.VeriarfyProtocolE19, signer.address).add8(row.group).encrypt();
    const estimate = await protocol.enroll.estimateGas(encrypted.handles[0], encrypted.inputProof, fee);
    await requireBudget("enroll", signer.address, estimate);
    await send("enroll", () => protocol.enroll(encrypted.handles[0], encrypted.inputProof, { ...fee, gasLimit: estimate * 12n / 10n }));
  }
  const consent = await clinical.consentOf(signer.address);
  if (consent.acceptedAt === 0n) {
    const latest = await ethers.provider.getBlock("latest");
    if (!latest) fail("latest block okunamadi");
    const expiresAt = BigInt(latest.timestamp) + 180n * 24n * 60n * 60n;
    const estimate = await clinical.acceptConsent.estimateGas(ethers.id(E19_CLINICAL_POLICY.panelId), ethers.id(E19_CLINICAL_POLICY.purposeId), ethers.id(E19_CLINICAL_POLICY.consentVersion), ethers.id(E19_CLINICAL_POLICY.consentDocumentId), expiresAt, fee);
    await requireBudget("accept-consent", signer.address, estimate);
    await send("accept-consent", () => clinical.acceptConsent(ethers.id(E19_CLINICAL_POLICY.panelId), ethers.id(E19_CLINICAL_POLICY.purposeId), ethers.id(E19_CLINICAL_POLICY.consentVersion), ethers.id(E19_CLINICAL_POLICY.consentDocumentId), expiresAt, { ...fee, gasLimit: estimate * 12n / 10n }));
  }
  if (!(await aggregate.contributed(signer.address))) {
    const encrypted = await fhevm.createEncryptedInput(record.contracts.VeriarfyClinicalAggregate, signer.address).add8(row.response).encrypt();
    const estimate = await aggregate.contributeResponses.estimateGas(encrypted.handles, encrypted.inputProof, fee);
    await requireBudget("contribute-response", signer.address, estimate);
    await send("contribute-response", () => aggregate.contributeResponses(encrypted.handles, encrypted.inputProof, { ...fee, gasLimit: estimate * 12n / 10n }));
  }
  if (!(await aggregate.contributed(signer.address))) fail("zincir klinik katkiyi dogrulamadi");
  console.log(JSON.stringify({ pass: true, participant: row.index, address: signer.address, group: row.group, response: row.response, participantCount: (await protocol.participantCount()).toString() }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
