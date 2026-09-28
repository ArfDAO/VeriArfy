/**
 * Teknofest BMI parity kontrati icin salt-okunur Sepolia maliyet on-kontrolu.
 * Bu betik islem gondermez, cüzdan yaratmaz ve fon kullanmaz.
 */
import { ethers, network } from "hardhat";

const CHAIN_ID = 11155111n;

function fail(message: string): never {
  throw new Error(`BMI demo preflight: ${message}`);
}

async function main() {
  if (network.name !== "sepolia") fail("yalniz Sepolia kabul edilir");
  const chain = await ethers.provider.getNetwork();
  if (chain.chainId !== CHAIN_ID) fail(`chainId ${chain.chainId}; ${CHAIN_ID} bekleniyor`);

  const signers = await ethers.getSigners();
  if (signers.length !== 1) fail(`tek deployer signer bekleniyor; ${signers.length} bulundu`);
  const deployer = signers[0];
  const factory = await ethers.getContractFactory("VeriarfyBmiDemo", deployer);
  const deployment = await factory.getDeployTransaction();
  if (!deployment.data) fail("deployment bytecode olusturulamadi");

  const [balance, gasLimit, feeData] = await Promise.all([
    ethers.provider.getBalance(deployer.address),
    ethers.provider.estimateGas({ from: deployer.address, data: deployment.data }),
    ethers.provider.getFeeData(),
  ]);
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (maxFeePerGas === null) fail("Sepolia fee verisi alinamadi");
  const estimatedMaxCost = gasLimit * maxFeePerGas;

  console.log(JSON.stringify({
    pass: balance >= estimatedMaxCost,
    network: network.name,
    chainId: chain.chainId.toString(),
    deployer: deployer.address,
    balanceWei: balance.toString(),
    balanceEth: ethers.formatEther(balance),
    estimatedGas: gasLimit.toString(),
    maxFeePerGasWei: maxFeePerGas.toString(),
    estimatedMaxCostWei: estimatedMaxCost.toString(),
    estimatedMaxCostEth: ethers.formatEther(estimatedMaxCost),
    fundingNeededWei: balance >= estimatedMaxCost ? "0" : (estimatedMaxCost - balance).toString(),
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
