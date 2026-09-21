/**
 * E/18 sentetik cohort için tek-katılımcı, yeniden başlatılabilir FHE aşaması.
 *
 * Anahtarlar repo dışında `%LOCALAPPDATA%/VeriArfy/e18-synthetic-cohort.json`
 * içinde tutulur. Bu script yalnız seçilen satırı kullanır; 60 işlemi paralel
 * göndermemek nonce/relayer hata yüzeyini ve faucet tüketimini sınırlar.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, fhevm, network } from "hardhat";
import { Wallet } from "ethers";

const ACK = "e18-synthetic-cohort";
const PROFILE = "e18-synthetic-bmi-snp-v1";
const MAX_FEE = ethers.parseUnits("2", "gwei");
const PRIORITY_FEE = ethers.parseUnits("0.1", "gwei");
const MAX_GAS = 6_000_000n;

type Row = { index: number; group: 0 | 1; dosage: 0 | 1 | 2; bmi: number; address: string; privateKey: string };

function fail(message: string): never { throw new Error(`E18 participant: ${message}`); }

function selectedRow(): Row {
  if (process.env.E18_COHORT_ACK !== ACK || process.env.E18_COHORT_EXECUTE !== "1") {
    fail("E18_COHORT_ACK ve E18_COHORT_EXECUTE=1 olmadan zincir islemi yasak");
  }
  const index = Number(process.env.E18_PARTICIPANT_INDEX);
  if (!Number.isInteger(index) || index < 0 || index >= 60) fail("E18_PARTICIPANT_INDEX 0..59 olmali");
  const path = join(process.env.LOCALAPPDATA ?? "", "VeriArfy", "e18-synthetic-cohort.json");
  let vault: { schema?: string; profile?: string; syntheticOnly?: boolean; participants?: Row[] };
  try { vault = JSON.parse(readFileSync(path, "utf8")); } catch { fail("yerel cohort vault okunamadi"); }
  const row = vault.participants?.[index];
  if (vault.schema !== "veriarfy.e18.synthetic-cohort.v1" || vault.profile !== PROFILE || vault.syntheticOnly !== true || !row ||
      row.index !== index || !ethers.isAddress(row.address) || !/^(0x)?[0-9a-fA-F]{64}$/.test(row.privateKey) ||
      (row.group !== 0 && row.group !== 1) || !Number.isInteger(row.dosage) || row.dosage < 0 || row.dosage > 2 ||
      !Number.isInteger(row.bmi) || row.bmi < 1000 || row.bmi > 8000) {
    fail("yerel cohort vault satiri gecersiz");
  }
  return row;
}

function deployment(): any {
  const path = join(__dirname, "..", "deployments", "e18-sepolia.json");
  let value: any;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { fail("E18 deployment kaydi okunamadi"); }
  if (value.profile !== PROFILE || value.network !== "sepolia" || value.chainId !== 11155111 || value.syntheticOnly !== true ||
      !ethers.isAddress(value.contracts?.VeriarfyProtocolE18) || !ethers.isAddress(value.contracts?.VeriarfyBiomarkers)) {
    fail("E18 deployment kaydi gecersiz");
  }
  return value;
}

async function overrides() {
  const latest = await ethers.provider.getBlock("latest");
  if ((latest?.baseFeePerGas ?? 0n) + PRIORITY_FEE > MAX_FEE) fail("Sepolia base fee gas tavanini asti; yeniden dene");
  return { maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: PRIORITY_FEE };
}

async function send(label: string, txFactory: () => Promise<any>) {
  const tx = await txFactory();
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) fail(`${label} basarisiz`);
  console.log(JSON.stringify({ label, hash: tx.hash, nonce: tx.nonce, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber }));
}

async function assertCurrentStepBudget(label: string, signer: string, estimate: bigint) {
  const required = estimate * 12n / 10n * MAX_FEE;
  const balance = await ethers.provider.getBalance(signer);
  if (balance < required) {
    console.log(JSON.stringify({ pass: false, label, balanceWei: balance.toString(), requiredWei: required.toString(), requiredSepoliaEth: ethers.formatEther(required), gas: estimate.toString() }, null, 2));
    fail(`${label} icin bakiye yetersiz; transaction gonderilmedi`);
  }
}

async function main() {
  if (network.name !== "sepolia" || (await ethers.provider.getNetwork()).chainId !== 11155111n) fail("yalniz Sepolia kabul edilir");
  const row = selectedRow();
  const record = deployment();
  const signer = new Wallet(row.privateKey, ethers.provider);
  if (signer.address.toLowerCase() !== row.address.toLowerCase()) fail("vault private key/adres uyusmuyor");
  const [protocol, biomarkers] = await Promise.all([
    ethers.getContractAt("VeriarfyProtocolE18", record.contracts.VeriarfyProtocolE18, signer),
    ethers.getContractAt("VeriarfyBiomarkers", record.contracts.VeriarfyBiomarkers, signer),
  ]);
  if (!(await protocol.e18DisclosurePolicyActive()) || (await protocol.minParticipants()) !== 60n || (await protocol.snpCount()) !== 1n ||
      (await protocol.biomarkerModule()).toLowerCase() !== record.contracts.VeriarfyBiomarkers.toLowerCase() || (await biomarkers.metricCount()) !== 1n) {
    fail("canli E18 politikasi/panel bekleneni vermiyor");
  }
  console.log(JSON.stringify({ stage: "fhe-client-init", participant: row.index }));
  await fhevm.initializeCLIApi();
  await fhevm.assertCoprocessorInitialized(record.contracts.VeriarfyProtocolE18, "VeriarfyProtocolE18");
  await fhevm.assertCoprocessorInitialized(record.contracts.VeriarfyBiomarkers, "VeriarfyBiomarkers");
  console.log(JSON.stringify({ stage: "fhe-client-ready", participant: row.index }));
  const fee = await overrides();

  if (!(await protocol.isEnrolled(signer.address))) {
    console.log(JSON.stringify({ stage: "encrypt-enroll", participant: row.index }));
    const input = await fhevm.createEncryptedInput(record.contracts.VeriarfyProtocolE18, signer.address).add8(row.group).encrypt();
    console.log(JSON.stringify({ stage: "estimate-enroll", participant: row.index }));
    const estimate = await protocol.enroll.estimateGas(input.handles[0], input.inputProof, fee);
    if (estimate > MAX_GAS) fail(`enroll gas tavanini asti: ${estimate}`);
    await assertCurrentStepBudget("enroll", signer.address, estimate);
    await send("enroll", () => protocol.enroll(input.handles[0], input.inputProof, { ...fee, gasLimit: estimate * 12n / 10n }));
  }
  if (!(await protocol.hasAggregated(signer.address))) {
    console.log(JSON.stringify({ stage: "encrypt-snp", participant: row.index }));
    const input = await fhevm.createEncryptedInput(record.contracts.VeriarfyProtocolE18, signer.address).add8(row.dosage).encrypt();
    console.log(JSON.stringify({ stage: "estimate-snp", participant: row.index }));
    const estimate = await protocol.contributeDosages.estimateGas(input.handles, 1n, input.inputProof, fee);
    if (estimate > MAX_GAS) fail(`SNP gas tavanini asti: ${estimate}`);
    await assertCurrentStepBudget("contribute-snp", signer.address, estimate);
    await send("contribute-snp", () => protocol.contributeDosages(input.handles, 1n, input.inputProof, { ...fee, gasLimit: estimate * 12n / 10n }));
  }
  if (!(await biomarkers.hasBiomarkerPanel(signer.address))) {
    console.log(JSON.stringify({ stage: "encrypt-bmi", participant: row.index }));
    const input = await fhevm.createEncryptedInput(record.contracts.VeriarfyBiomarkers, signer.address).add32(row.bmi).encrypt();
    console.log(JSON.stringify({ stage: "estimate-bmi", participant: row.index }));
    const estimate = await biomarkers.contributeBiomarkers.estimateGas(input.handles, 1n, input.inputProof, fee);
    if (estimate > MAX_GAS) fail(`BMI gas tavanini asti: ${estimate}`);
    await assertCurrentStepBudget("contribute-bmi", signer.address, estimate);
    await send("contribute-bmi", () => biomarkers.contributeBiomarkers(input.handles, 1n, input.inputProof, { ...fee, gasLimit: estimate * 12n / 10n }));
  }
  if (!(await protocol.hasAggregated(signer.address)) || !(await biomarkers.hasBiomarkerPanel(signer.address))) fail("zincir katilimci katkisini dogrulamadi");
  console.log(JSON.stringify({ pass: true, participant: row.index, address: signer.address, group: row.group, dosage: row.dosage, bmi: row.bmi, participantCount: (await protocol.participantCount()).toString() }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
