import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ethers, network } from "hardhat";

import {
  D15_PROFILE_ID,
  loadD15Profile,
  parseD15NodeRole,
  sameAddress,
} from "./d15-profile";

function deploymentNodes(record: any): string[] {
  if (!Array.isArray(record.authorizedNodes)) {
    throw new Error("deployment JSON authorizedNodes icermiyor");
  }
  return record.authorizedNodes.map((node: unknown) => ethers.getAddress(String(node)));
}

async function main() {
  if (process.env.D15_PROFILE !== D15_PROFILE_ID) {
    throw new Error(`D15_PROFILE=${D15_PROFILE_ID} zorunludur`);
  }

  const profile = loadD15Profile();
  const role = parseD15NodeRole(process.env.D15_NODE_ROLE);
  const expectedAck = `stake-${role}`;
  const ack = process.env.D15_EXECUTION_ACK?.trim();
  const execute = ack === expectedAck;
  if (ack && !execute) {
    throw new Error(`D15_EXECUTION_ACK '${expectedAck}' olmalidir`);
  }

  const chain = await ethers.provider.getNetwork();
  if (network.name !== profile.network || chain.chainId !== BigInt(profile.chainId)) {
    throw new Error("stake-node yalniz profile'daki Sepolia aginda calisir");
  }

  const record = JSON.parse(
    readFileSync(join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"),
  );
  if (record.chainId !== profile.chainId || !sameAddress(record.deployer, profile.deployer)) {
    throw new Error("deployment JSON D15 profile deployer/chain bilgisiyle eslesmiyor");
  }

  const nodes = deploymentNodes(record);
  if (
    nodes.length !== 2 ||
    !sameAddress(nodes[0], profile.authorizedNodes[0]) ||
    !sameAddress(nodes[1], profile.authorizedNodes[1])
  ) {
    throw new Error("deployment JSON node sirasi D15 profile ile eslesmiyor");
  }

  const nodeIndex = role === "node-1" ? 0 : 1;
  const expectedNode = profile.authorizedNodes[nodeIndex];
  const protocolAddress = ethers.getAddress(record.contracts?.VeriarfyProtocol);
  const stakingAddress = ethers.getAddress(record.contracts?.VeriarfyStaking);
  const protocol: any = await ethers.getContractAt("VeriarfyProtocol", protocolAddress);
  const staking: any = await ethers.getContractAt("VeriarfyStaking", stakingAddress);

  if (!sameAddress(await protocol.stakingModule(), stakingAddress)) {
    throw new Error("staking module deployment ile zincirde eslesmiyor");
  }
  if (!(await protocol.isAuthorizedNode(expectedNode))) {
    throw new Error(`${role} zincirde yetkili degil`);
  }
  if (await staking.isBanned(expectedNode)) {
    throw new Error(`${role} zincirde banli`);
  }

  const [rawBalance, rawStaked, rawMinimum, rawCanApprove] = await Promise.all([
    ethers.provider.getBalance(expectedNode),
    staking.stakeOf(expectedNode),
    staking.minStake(),
    staking.canApprove(expectedNode),
  ]);
  const balance = BigInt(rawBalance);
  const staked = BigInt(rawStaked);
  const minimum = BigInt(rawMinimum);
  const canApprove = Boolean(rawCanApprove);
  console.log(`${role}       : ${expectedNode}`);
  console.log(`Bakiye       : ${ethers.formatEther(balance)} Sepolia ETH`);
  console.log(`Stake        : ${ethers.formatEther(staked)} ETH`);
  console.log(`minStake     : ${ethers.formatEther(minimum)} ETH`);
  console.log(`canApprove   : ${canApprove}`);

  if (staked >= minimum && canApprove) {
    console.log("Stake zaten yeterli; transaction gerekmiyor.");
    return;
  }
  if (staked >= minimum) {
    throw new Error(`${role} stake yeterli oldugu halde canApprove=false`);
  }
  if (minimum > profile.nodeBaseStakeWei) {
    throw new Error(
      `minStake profile cap'ini asti: ${minimum} > ${profile.nodeBaseStakeWei}; ` +
        "manuel inceleme olmadan fon gonderilmeyecek",
    );
  }

  const shortfall = minimum - staked;
  const feeData = await ethers.provider.getFeeData();
  const feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  const estimatedGas = BigInt(
    await staking.stake.estimateGas({
      from: expectedNode,
      value: shortfall,
    }),
  );
  const estimatedMaximum = feePerGas === null ? null : shortfall + estimatedGas * feePerGas;
  console.log(`Eksik stake  : ${ethers.formatEther(shortfall)} ETH`);
  console.log(`Tahmini gas  : ${estimatedGas}`);
  if (estimatedMaximum !== null) {
    console.log(`Stake+maxGas : ${ethers.formatEther(estimatedMaximum)} ETH`);
    if (balance < estimatedMaximum) throw new Error(`${role} bakiyesi stake+gas icin yetersiz`);
  } else if (execute) {
    throw new Error("gas fiyati okunamadi; execution fail-closed durduruldu");
  }

  if (!execute) {
    console.log("Salt-okunur plan tamamlandi; D15_EXECUTION_ACK olmadigi icin tx gonderilmedi.");
    return;
  }

  const signers = await ethers.getSigners();
  if (signers.length !== 1 || !sameAddress(signers[0].address, expectedNode)) {
    throw new Error(`${role} signer profile adresiyle eslesmiyor`);
  }

  const tx = await staking.connect(signers[0]).stake({ value: shortfall });
  const receipt = await tx.wait();
  console.log(`stake tx     : ${tx.hash} (gas ${receipt?.gasUsed})`);
  if (!(await staking.canApprove(expectedNode))) {
    throw new Error(`${role} stake sonrasi canApprove=false`);
  }
  console.log(`${role} stake tamamlandi ve canApprove=true.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`D15 node stake BASARISIZ: ${error.message ?? error}`);
    process.exit(1);
  });
