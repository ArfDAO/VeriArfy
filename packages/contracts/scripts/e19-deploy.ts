/** Deploy the separate synthetic-only E/19 clinical/payment profile to Sepolia. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";
import { E19_CLINICAL_POLICY } from "@veriarfy/study";

const ACK = "e19-synthetic-sepolia-deploy";
const PROFILE = "e19-synthetic-cyp2c19-clopidogrel-v1";
const CHAIN_ID = 11155111n;
// This is deliberately conservative: partial deployments are worse than waiting for a faucet claim.
// Eight compact contracts plus their initialization transactions were kept
// below this testnet guard; the margin prevents starting at a dust balance.
const MIN_DEPLOY_BALANCE = ethers.parseEther("0.018");

function fail(message: string): never { throw new Error(`E19 deploy: ${message}`); }

async function main() {
  if (network.name !== "sepolia" || process.env.E19_DEPLOY_ACK !== ACK) fail(`yalniz Sepolia ve E19_DEPLOY_ACK=${ACK} kabul edilir`);
  if ((await ethers.provider.getNetwork()).chainId !== CHAIN_ID) fail("chainId 11155111 bekleniyor");
  const signers = await ethers.getSigners();
  if (signers.length !== 1) fail(`tek izole deployer bekleniyor; ${signers.length} bulundu`);
  const deployer = signers[0];
  const [balance, block] = await Promise.all([ethers.provider.getBalance(deployer.address), ethers.provider.getBlock("latest")]);
  if (balance < MIN_DEPLOY_BALANCE) fail(`bakiye yetersiz: ${ethers.formatEther(balance)} ETH; en az ${ethers.formatEther(MIN_DEPLOY_BALANCE)} ETH gerekli`);
  if (!block) fail("latest block okunamadi");

  const Verifier = await ethers.getContractFactory("Groth16Verifier", deployer);
  const verifier = await Verifier.deploy(); await verifier.waitForDeployment();
  const Registry = await ethers.getContractFactory("VeriArfyRegistry", deployer);
  const registry = await Registry.deploy(await verifier.getAddress(), 0); await registry.waitForDeployment();
  const Protocol = await ethers.getContractFactory("VeriarfyProtocolE19", deployer);
  const protocol = await Protocol.deploy(deployer.address, 1); await protocol.waitForDeployment();
  const Clinical = await ethers.getContractFactory("VeriarfyClinical", deployer);
  const clinical = await Clinical.deploy(await protocol.getAddress(), await registry.getAddress()); await clinical.waitForDeployment();
  const Stats = await ethers.getContractFactory("ClinicalResponseStats", deployer);
  const stats = await Stats.deploy(); await stats.waitForDeployment();
  const Aggregate = await ethers.getContractFactory("VeriarfyClinicalAggregate", { signer: deployer, libraries: { ClinicalResponseStats: await stats.getAddress() } });
  const aggregate = await Aggregate.deploy(await protocol.getAddress(), await clinical.getAddress(), ethers.id(E19_CLINICAL_POLICY.panelId), ethers.id(E19_CLINICAL_POLICY.purposeId)); await aggregate.waitForDeployment();
  const Token = await ethers.getContractFactory("StableTestToken", deployer);
  const token = await Token.deploy(deployer.address); await token.waitForDeployment();
  const Payments = await ethers.getContractFactory("VeriarfyE19Payments", deployer);
  const payments = await Payments.deploy(deployer.address, await protocol.getAddress(), await aggregate.getAddress(), await token.getAddress(), await registry.getAddress(), 1_000_000, 50_000, 8_000, 50_000); await payments.waitForDeployment();

  const endpoint = ethers.id("synthetic-clopidogrel-response-v1");
  const maxConsentDuration = BigInt(E19_CLINICAL_POLICY.maximumConsentDays) * 24n * 60n * 60n;
  await (await protocol.setClinicalModule(await aggregate.getAddress())).wait();
  await (await clinical.configurePolicy({ panelId: ethers.id(E19_CLINICAL_POLICY.panelId), purposeId: ethers.id(E19_CLINICAL_POLICY.purposeId), consentVersion: ethers.id(E19_CLINICAL_POLICY.consentVersion), panelHash: ethers.id(E19_CLINICAL_POLICY.panelDocumentId), consentDocumentHash: ethers.id(E19_CLINICAL_POLICY.consentDocumentId), maxConsentDuration, panelUri: E19_CLINICAL_POLICY.panelUri })).wait();
  await (await aggregate.configureEndpoints([endpoint], ethers.id(E19_CLINICAL_POLICY.panelDocumentId), E19_CLINICAL_POLICY.panelUri)).wait();
  await (await protocol.authorizeNode(deployer.address)).wait();
  await (await protocol.setQueryGateway(await payments.getAddress())).wait();

  const contracts = { Groth16Verifier: await verifier.getAddress(), VeriArfyRegistry: await registry.getAddress(), VeriarfyProtocolE19: await protocol.getAddress(), VeriarfyClinical: await clinical.getAddress(), ClinicalResponseStats: await stats.getAddress(), VeriarfyClinicalAggregate: await aggregate.getAddress(), StableTestToken: await token.getAddress(), VeriarfyE19Payments: await payments.getAddress() };
  const code = await Promise.all(Object.values(contracts).map((address) => ethers.provider.getCode(address)));
  if (code.some((value) => value === "0x")) fail("deployment sonrasinda kontrat bytecode bulunamadi");
  const record = { profile: PROFILE, network: "sepolia", chainId: Number(CHAIN_ID), syntheticOnly: true, deployer: deployer.address, authorizedNodes: [deployer.address], endpoint, contracts, deploymentStartBlock: block.number, deployedAtBlock: await ethers.provider.getBlockNumber(), registration: { zkRequired: true, completed: false }, liveSettlement: { completed: false, participantTarget: 60 } };
  const directory = join(__dirname, "..", "deployments");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "e19-sepolia.json"), `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify(record, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
