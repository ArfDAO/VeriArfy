/**
 * Gercek Sepolia fhEVM BMI parity kaniti.
 * Sadece sabit, sentetik 72.4 kg / 175 cm girdi kullanir; gerçek kisi verisi
 * kabul etmez. Ham kilo handle'i kamuya acilmaz; demo BMI'i public decrypt olur.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, fhevm, network } from "hardhat";

const ACK = "bmi-demo-live-check";
const CHAIN_ID = 11155111n;
const HEIGHT_CM = 175;
const WEIGHT_DECI_KG = 724;
const EXPECTED_BMI_X100 = 2364n;
const MAX_FEE_PER_GAS = ethers.parseUnits("2", "gwei");
const MAX_PRIORITY_FEE = ethers.parseUnits("0.1", "gwei");

function fail(message: string): never {
  throw new Error(`BMI demo live check: ${message}`);
}

function deployment(): { contract: string; network: string; chainId: number; syntheticOnly: boolean } {
  const path = join(__dirname, "..", "deployments", "bmi-demo-sepolia.json");
  let record: any;
  try { record = JSON.parse(readFileSync(path, "utf8")); } catch { fail("BMI demo deployment kaydi okunamadi"); }
  if (record.network !== "sepolia" || record.chainId !== Number(CHAIN_ID) || record.syntheticOnly !== true || !ethers.isAddress(record.contract)) {
    fail("BMI demo deployment kaydi gecersiz");
  }
  return record;
}

async function main() {
  if (process.env.BMI_DEMO_LIVE_ACK !== ACK || process.env.BMI_DEMO_LIVE_EXECUTE !== "1") {
    fail("zincir islemi icin BMI_DEMO_LIVE_ACK ve BMI_DEMO_LIVE_EXECUTE=1 zorunlu");
  }
  if (network.name !== "sepolia" || (await ethers.provider.getNetwork()).chainId !== CHAIN_ID) fail("yalniz Sepolia kabul edilir");
  const record = deployment();
  const signers = await ethers.getSigners();
  if (signers.length !== 1) fail(`tek demo signer bekleniyor; ${signers.length} bulundu`);
  const signer = signers[0];
  const bmi = await ethers.getContractAt("VeriarfyBmiDemo", record.contract, signer);
  if ((await ethers.provider.getCode(record.contract)) === "0x") fail("BMI demo kontrat bytecode bulunamadi");

  await fhevm.initializeCLIApi();
  await fhevm.assertCoprocessorInitialized(record.contract, "VeriarfyBmiDemo");
  const encrypted = await fhevm
    .createEncryptedInput(record.contract, signer.address)
    .add16(WEIGHT_DECI_KG)
    .encrypt();
  const latest = await ethers.provider.getBlock("latest");
  if ((latest?.baseFeePerGas ?? 0n) + MAX_PRIORITY_FEE > MAX_FEE_PER_GAS) fail("Sepolia base fee 2 gwei tavanini asti");
  const fee = { maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: MAX_PRIORITY_FEE };
  const estimatedGas = await bmi.calculate.estimateGas(encrypted.handles[0], HEIGHT_CM, encrypted.inputProof, fee);
  const required = estimatedGas * 12n / 10n * MAX_FEE_PER_GAS;
  if ((await ethers.provider.getBalance(signer.address)) < required) fail(`yetersiz bakiye; en az ${ethers.formatEther(required)} SepETH gerekli`);

  const tx = await bmi.calculate(encrypted.handles[0], HEIGHT_CM, encrypted.inputProof, { ...fee, gasLimit: estimatedGas * 12n / 10n });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) fail("calculate islemi basarisiz");
  const handle = await bmi.bmiHandle(signer.address);
  if (handle === ethers.ZeroHash) fail("zincirde BMI FHE handle'i olusmadi");
  const decrypted = await fhevm.publicDecrypt([handle]);
  const bmiX100 = BigInt((decrypted.clearValues as Record<string, string | number | bigint>)[handle.toLowerCase()]);
  if (bmiX100 !== EXPECTED_BMI_X100) fail(`parity bozuk: ${bmiX100}; ${EXPECTED_BMI_X100} bekleniyor`);

  console.log(JSON.stringify({
    pass: true,
    syntheticOnly: true,
    contract: record.contract,
    address: signer.address,
    heightCm: HEIGHT_CM,
    weightDeciKg: WEIGHT_DECI_KG,
    plaintextBmiX100: EXPECTED_BMI_X100.toString(),
    fheBmiX100: bmiX100.toString(),
    encryptedWeightPubliclyDecryptable: false,
    finalBmiPubliclyDecryptable: true,
    transactionHash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
