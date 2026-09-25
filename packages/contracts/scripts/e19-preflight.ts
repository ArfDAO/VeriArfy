/** Read-only guard for the separate E/19 synthetic Sepolia profile. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, fhevm, network } from "hardhat";
import { E19_CLINICAL_POLICY } from "@veriarfy/study";

const PROFILE = "e19-synthetic-cyp2c19-clopidogrel-v1";
function fail(message: string): never { throw new Error(`E19 preflight: ${message}`); }

async function main() {
  if (network.name !== "sepolia" || (await ethers.provider.getNetwork()).chainId !== 11155111n) fail("yalniz Sepolia kabul edilir");
  const path = join(__dirname, "..", "deployments", "e19-sepolia.json");
  let record: any;
  try { record = JSON.parse(readFileSync(path, "utf8")); } catch { fail("deployment kaydi okunamadi"); }
  if (record.profile !== PROFILE || record.syntheticOnly !== true || record.network !== "sepolia") fail("deployment profili gecersiz");
  const names = ["Groth16Verifier", "VeriArfyRegistry", "VeriarfyProtocolE19", "VeriarfyClinical", "ClinicalResponseStats", "VeriarfyClinicalAggregate", "StableTestToken", "VeriarfyE19Payments"];
  for (const name of names) if (!ethers.isAddress(record.contracts?.[name])) fail(`gecersiz adres: ${name}`);
  const [protocol, aggregate, payments, clinical] = await Promise.all([
    ethers.getContractAt("VeriarfyProtocolE19", record.contracts.VeriarfyProtocolE19),
    ethers.getContractAt("VeriarfyClinicalAggregate", record.contracts.VeriarfyClinicalAggregate),
    ethers.getContractAt("VeriarfyE19Payments", record.contracts.VeriarfyE19Payments),
    ethers.getContractAt("VeriarfyClinical", record.contracts.VeriarfyClinical),
  ]);
  const [policy, count, gateway, module, endpoints, opened, code] = await Promise.all([clinical.policy(), protocol.participantCount(), protocol.queryGateway(), protocol.clinicalModule(), aggregate.endpointCount(), payments.opened(), Promise.all(names.map((name) => ethers.provider.getCode(record.contracts[name])))]);
  if (gateway.toLowerCase() !== record.contracts.VeriarfyE19Payments.toLowerCase() || module.toLowerCase() !== record.contracts.VeriarfyClinicalAggregate.toLowerCase() || endpoints !== 1n || opened || code.some((value) => value === "0x")) fail("zincir topolojisi bekleneni vermiyor");
  if (policy.panelId !== ethers.id(E19_CLINICAL_POLICY.panelId) || policy.purposeId !== ethers.id(E19_CLINICAL_POLICY.purposeId)) fail("onam politikasi eslesmiyor");
  await fhevm.initializeCLIApi();
  await fhevm.assertCoprocessorInitialized(record.contracts.VeriarfyProtocolE19, "VeriarfyProtocolE19");
  await fhevm.assertCoprocessorInitialized(record.contracts.VeriarfyClinicalAggregate, "VeriarfyClinicalAggregate");
  console.log(JSON.stringify({ pass: true, profile: PROFILE, fhEvmMock: fhevm.isMock, participantCount: count.toString(), contracts: record.contracts, next: "real ZK researcher registration and 60 synthetic FHE contributors" }, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
