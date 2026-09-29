import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

const ACK = "e18-synthetic-sepolia-deploy";

function nodes(value: string | undefined): string[] {
  const parsed = (value ?? "").split(",").map((item) => item.trim()).filter(Boolean).map(ethers.getAddress);
  if (parsed.length < 2 || new Set(parsed.map((item) => item.toLowerCase())).size !== parsed.length) throw new Error("E18_AUTHORIZED_NODES iki farkli public adres olmali");
  return parsed;
}

async function main() {
  if (network.name !== "sepolia" || process.env.E18_DEPLOY_ACK !== ACK) throw new Error("E18 deploy yalniz Sepolia'da E18_DEPLOY_ACK ile calisir");
  const chain = await ethers.provider.getNetwork();
  if (chain.chainId !== 11155111n) throw new Error("E18 deploy chainId 11155111 bekler");
  const [deployer, ...extra] = await ethers.getSigners();
  if (extra.length) throw new Error("E18 deploy tek deployer signer gerektirir");
  const authorizedNodes = nodes(process.env.E18_AUTHORIZED_NODES);
  const balance = await ethers.provider.getBalance(deployer.address);
  if (balance === 0n) throw new Error("E18 deployer bakiyesi sifir; faucet gerekli");

  const verifier = await (await ethers.getContractFactory("DataProvenanceVerifier")).deploy(); await verifier.waitForDeployment();
  const contingency = await (await ethers.getContractFactory("ContingencyStats")).deploy(); await contingency.waitForDeployment();
  const coverage = await (await ethers.getContractFactory("CoverageBits")).deploy(); await coverage.waitForDeployment();
  const Protocol = await ethers.getContractFactory("VeriarfyProtocolE18", { libraries: { ContingencyStats: await contingency.getAddress(), CoverageBits: await coverage.getAddress() } });
  const protocol = await Protocol.deploy(deployer.address, 2, await verifier.getAddress(), 0); await protocol.waitForDeployment();
  const biomarkerStats = await (await ethers.getContractFactory("BiomarkerStats")).deploy(); await biomarkerStats.waitForDeployment();
  const Biomarkers = await ethers.getContractFactory("VeriarfyBiomarkers", { libraries: { BiomarkerStats: await biomarkerStats.getAddress(), CoverageBits: await coverage.getAddress() } });
  const biomarkers = await Biomarkers.deploy(await protocol.getAddress()); await biomarkers.waitForDeployment();
  await (await protocol.setBiomarkerModule(await biomarkers.getAddress())).wait();
  await (await protocol.configurePanel(1, 0, ethers.id("e18-synthetic-bmi-snp-v1"), "ipfs://e18-synthetic-bmi-snp-v1")).wait();
  await (await biomarkers.configureMetrics([{ code: ethers.encodeBytes32String("BMI"), unit: ethers.encodeBytes32String("kg/m2"), scale: 100, offset: 0, minValue: 1000, maxValue: 8000 }], ethers.id("e18-synthetic-bmi-snp-v1"), "ipfs://e18-synthetic-bmi-snp-v1")).wait();
  for (const node of authorizedNodes) await (await protocol.authorizeNode(node)).wait();
  await (await protocol.setQueryGateway(deployer.address)).wait();
  const record = { profile: "e18-synthetic-bmi-snp-v1", network: "sepolia", chainId: 11155111, deployer: deployer.address, authorizedNodes, contracts: { DataProvenanceVerifier: await verifier.getAddress(), ContingencyStats: await contingency.getAddress(), CoverageBits: await coverage.getAddress(), VeriarfyProtocolE18: await protocol.getAddress(), BiomarkerStats: await biomarkerStats.getAddress(), VeriarfyBiomarkers: await biomarkers.getAddress() }, syntheticOnly: true, deployedAtBlock: await ethers.provider.getBlockNumber() };
  mkdirSync(join(__dirname, "..", "deployments"), { recursive: true });
  writeFileSync(join(__dirname, "..", "deployments", "e18-sepolia.json"), `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify(record, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
