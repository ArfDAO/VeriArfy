/**
 * Yetkili dugumleri fonlar ve teminatlandirir.
 *
 * NEDEN AYRI BIR BETIK: `stake-node.ts` D15 public profiline kilitli
 * (deployer ve dugum adresleri dondurulmus profille eslesmek zorunda), bu
 * yuzden bizim dagitimimizda calismaz. Bu betik ayni isi profil kilidi
 * olmadan yapar ve yalnizca deployments/<network>.json dosyasini kaynak alir.
 *
 * NE ISE YARAR: `approveDisclosure` hem `isAuthorizedNode` hem de teminat
 * sarti ariyor (staking modulu atanmissa `canApprove`). Dugumler
 * teminatlandirilmadan arastirmaci bir sorgunun sonucunu ALAMAZ - talep
 * acilir ama hicbir zaman onaylanmaz. Yani bu adim opsiyonel bir suslemede
 * degil, odeme akisinin isleyebilmesinin sarti.
 *
 * Kullanim:
 *   NODE_WALLETS=../../node-wallets.local.json \
 *   npx hardhat run scripts/bootstrap-nodes.ts --network sepolia
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { ethers, network } from "hardhat";

/** Dugum basina yatirilacak teminat. minStake() havuz degeriyle olceklendigi
 *  icin taban degerin (0,001 ETH) uzerine pay birakiyoruz. */
const STAKE = ethers.parseEther("0.005");
/** Onay islemlerinin gazi icin dugumde birakilan tutar. */
const GAS_BUFFER = ethers.parseEther("0.004");

async function main() {
  const walletsEnv = process.env.NODE_WALLETS;
  if (!walletsEnv) throw new Error("NODE_WALLETS dosya yolu zorunludur");
  const walletsPath = isAbsolute(walletsEnv) ? walletsEnv : join(__dirname, "..", walletsEnv);

  const { nodes } = JSON.parse(readFileSync(walletsPath, "utf8")) as {
    nodes: { address: string; privateKey: string }[];
  };
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("NODE_WALLETS dosyasinda dugum yok");
  }

  const record = JSON.parse(
    readFileSync(join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"),
  );
  const stakingAddress = record.contracts.VeriarfyStaking as string;
  const protocolAddress = record.contracts.VeriarfyProtocol as string;

  const [deployer] = await ethers.getSigners();
  const protocol = await ethers.getContractAt("VeriarfyProtocol", protocolAddress);
  const staking = await ethers.getContractAt("VeriarfyStaking", stakingAddress);

  console.log(`Ag        : ${network.name}`);
  console.log(`Staking   : ${stakingAddress}`);
  console.log(`Deployer  : ${deployer.address}`);
  console.log(`minStake(): ${ethers.formatEther(await staking.minStake())} ETH\n`);

  for (const node of nodes) {
    const address = ethers.getAddress(node.address);
    console.log(`--- ${address} ---`);

    if (!(await protocol.isAuthorizedNode(address))) {
      console.log("  yetkili dugum degil - atlandi (deploy sirasinda yetkilendirilmeliydi)");
      continue;
    }

    // Zaten yeterli teminati varsa dokunmuyoruz: betik tekrar calistirildiginda
    // ikinci kez para yatirmasin.
    const staked = await staking.stakeOf(address);
    const required = await staking.minStake();
    if (staked >= required) {
      console.log(`  teminat yeterli (${ethers.formatEther(staked)} ETH) - atlandi`);
      continue;
    }

    const missing = required > STAKE ? required - staked : STAKE - staked;
    const balance = await ethers.provider.getBalance(address);
    const needed = missing + GAS_BUFFER;

    if (balance < needed) {
      const topUp = needed - balance;
      console.log(`  fonlaniyor: ${ethers.formatEther(topUp)} ETH`);
      const fund = await deployer.sendTransaction({ to: address, value: topUp });
      await fund.wait();
    }

    const signer = new ethers.Wallet(node.privateKey, ethers.provider);
    const tx = await staking.connect(signer).stake({ value: missing });
    console.log(`  teminat yatiriliyor: ${tx.hash}`);
    await tx.wait();

    console.log(`  stakeOf   : ${ethers.formatEther(await staking.stakeOf(address))} ETH`);
    console.log(`  canApprove: ${await staking.canApprove(address)}`);
  }

  console.log(`\nDeployer bakiye: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
