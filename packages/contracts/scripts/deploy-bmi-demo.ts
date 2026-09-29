/**
 * Sentetik Teknofest BMI parity kontratini Sepolia'ya dagitir.
 * Islem, ancak acik acknowledgement ile gonderilir; ham kilo asla zincirde
 * acilmaz, yalnızca nihai BMI handle'i demo amaciyla public decrypt edilebilir.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, network } from "hardhat";

const ACK = "bmi-demo-sepolia-deploy";
const CHAIN_ID = 11155111n;

function fail(message: string): never {
  throw new Error(`BMI demo deploy: ${message}`);
}

async function main() {
  if (network.name !== "sepolia") fail("yalniz Sepolia kabul edilir");
  if (process.env.BMI_DEMO_DEPLOY_ACK !== ACK) fail(`islem gondermek icin BMI_DEMO_DEPLOY_ACK=${ACK} zorunlu`);
  const chain = await ethers.provider.getNetwork();
  if (chain.chainId !== CHAIN_ID) fail(`chainId ${chain.chainId}; ${CHAIN_ID} bekleniyor`);

  const signers = await ethers.getSigners();
  if (signers.length !== 1) fail(`tek deployer signer bekleniyor; ${signers.length} bulundu`);
  const deployer = signers[0];
  const factory = await ethers.getContractFactory("VeriarfyBmiDemo", deployer);
  const estimated = await factory.getDeployTransaction();
  if (!estimated.data) fail("deployment bytecode olusturulamadi");
  const [balance, gasLimit, feeData] = await Promise.all([
    ethers.provider.getBalance(deployer.address),
    ethers.provider.estimateGas({ from: deployer.address, data: estimated.data }),
    ethers.provider.getFeeData(),
  ]);
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (maxFeePerGas === null) fail("Sepolia fee verisi alinamadi");
  if (balance < gasLimit * maxFeePerGas) fail("deployer bakiyesi tahmini maliyetten dusuk; faucet veya funding gerekli");

  const contract = await factory.deploy();
  const deploymentTx = contract.deploymentTransaction();
  if (!deploymentTx) fail("deployment transaction olusturulamadi");
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  if ((await ethers.provider.getCode(address)) === "0x") fail("deployment sonrasinda kontrat bytecode bulunamadi");

  const receipt = await deploymentTx.wait();
  if (!receipt) fail("deployment receipt alinamadi");
  const record = {
    profile: "teknofest-synthetic-bmi-parity-v1",
    network: "sepolia",
    chainId: Number(CHAIN_ID),
    deployer: deployer.address,
    contract: address,
    syntheticOnly: true,
    rawWeightPubliclyDecryptable: false,
    finalBmiPubliclyDecryptable: true,
    transactionHash: deploymentTx.hash,
    deployedAtBlock: receipt.blockNumber,
  };
  const directory = join(__dirname, "..", "deployments");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "bmi-demo-sepolia.json"), `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify(record, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
