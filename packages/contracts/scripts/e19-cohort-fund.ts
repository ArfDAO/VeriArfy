/** Fund one FarukOS-vault E/19 synthetic participant with a bounded Sepolia amount. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

const ACK = "e19-synthetic-cohort";
const PROFILE = "e19-synthetic-cyp2c19-clopidogrel-v1";
const MAX_RECIPIENT_BALANCE = ethers.parseEther("0.01");
const MAX_FEE = ethers.parseUnits("2", "gwei");
const PRIORITY_FEE = ethers.parseUnits("0.1", "gwei");

type Row = { index: number; address: string };

function fail(message: string): never { throw new Error(`E19 cohort fund: ${message}`); }

function target(): Row {
  if (process.env.E19_COHORT_ACK !== ACK || process.env.E19_COHORT_FUND !== "1") {
    fail(`E19_COHORT_ACK=${ACK} ve E19_COHORT_FUND=1 olmadan transfer yasak`);
  }
  const index = Number(process.env.E19_PARTICIPANT_INDEX);
  if (!Number.isInteger(index) || index < 0 || index >= 60) fail("E19_PARTICIPANT_INDEX 0..59 olmali");
  const home = process.env.USERPROFILE;
  if (!home) fail("USERPROFILE bulunamadi; FarukOS kasasi yolu belirlenemiyor");
  let vault: { schema?: string; profile?: string; syntheticOnly?: boolean; participants?: Row[] };
  try { vault = JSON.parse(readFileSync(join(home, "FarukOS", "🔐 400-Vault", "VeriArfy", "e19-synthetic-cohort.json"), "utf8")); } catch { fail("FarukOS cohort kasasi okunamadi"); }
  const row = vault.participants?.[index];
  if (vault.schema !== "veriarfy.e19.synthetic-cohort.v1" || vault.profile !== PROFILE || vault.syntheticOnly !== true || !row || row.index !== index || !ethers.isAddress(row.address)) {
    fail("FarukOS cohort satiri gecersiz");
  }
  return row;
}

function deployment(): any {
  let value: any;
  try { value = JSON.parse(readFileSync(join(__dirname, "..", "deployments", "e19-sepolia.json"), "utf8")); } catch { fail("E19 deployment kaydi okunamadi"); }
  if (value.profile !== PROFILE || !ethers.isAddress(value.deployer)) fail("E19 deployment kaydi gecersiz");
  return value;
}

async function main() {
  if (network.name !== "sepolia" || (await ethers.provider.getNetwork()).chainId !== 11155111n) fail("yalniz Sepolia kabul edilir");
  const row = target();
  const record = deployment();
  const [deployer, ...extra] = await ethers.getSigners();
  if (extra.length || deployer.address.toLowerCase() !== record.deployer.toLowerCase()) fail("yalniz izole E19 deployer kabul edilir");
  const requested = ethers.parseEther(process.env.E19_FUND_AMOUNT ?? "");
  if (requested <= 0n || requested > MAX_RECIPIENT_BALANCE) fail("E19_FUND_AMOUNT 0 ile 0.01 sepETH arasynda olmali");
  const [current, source, latest] = await Promise.all([ethers.provider.getBalance(row.address), ethers.provider.getBalance(deployer.address), ethers.provider.getBlock("latest")]);
  if (current >= requested) {
    console.log(JSON.stringify({ pass: true, participant: row.index, address: row.address, funded: false, balanceSepETH: ethers.formatEther(current) }));
    return;
  }
  if ((latest?.baseFeePerGas ?? 0n) + PRIORITY_FEE > MAX_FEE) fail("Sepolia base fee gas tavanini asti; yeniden dene");
  const value = requested - current;
  if (source < value + ethers.parseEther("0.01")) fail("E19 deployer rezervi korunarak transfer icin bakiye yetersiz");
  const tx = await deployer.sendTransaction({ to: row.address, value, maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: PRIORITY_FEE });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) fail("participant fonlama basarisiz");
  console.log(JSON.stringify({ pass: true, participant: row.index, address: row.address, hash: tx.hash, valueSepETH: ethers.formatEther(value), balanceSepETH: ethers.formatEther(await ethers.provider.getBalance(row.address)) }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
