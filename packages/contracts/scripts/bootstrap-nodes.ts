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

/**
 * Teminat, o anki `minStake()` degerinin bu kati kadar yatirilir.
 *
 * SABIT BIR TUTAR YETMEZ. `minStake()` havuzun toplam degeriyle birlikte
 * BUYUYOR (progresif teminat). Sabit 0,005 ETH yatirildiginda esik bir sure
 * sonra onu asti ve dugumler sessizce `canApprove=false` oldu: servis
 * calisiyor, hata vermiyor, ama hicbir talebi onaylayamiyordu. Pay birakmak
 * bu sessiz durusu geciktirir; tamamen engellemek icin izleme sart.
 */
const STAKE_MULTIPLIER = BigInt(process.env.STAKE_MULTIPLIER ?? "4");

/** Havuz henuz degersizken bile anlamli bir taban. */
const MIN_STAKE_FLOOR = ethers.parseEther("0.005");
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

    const staked = await staking.stakeOf(address);
    const required = await staking.minStake();

    // HEDEF, esigin KATI olarak belirlenir. Sadece esigi karsilamak yeterli
    // degil: esik havuz buyudukce yukseliyor ve dugum bir sonraki sorguda
    // yine altinda kalirdi.
    let target = required * STAKE_MULTIPLIER;
    if (target < MIN_STAKE_FLOOR) target = MIN_STAKE_FLOOR;

    console.log(`  esik ${ethers.formatEther(required)} / mevcut ${ethers.formatEther(staked)} / hedef ${ethers.formatEther(target)}`);

    if (staked >= target) {
      console.log("  teminat yeterli - atlandi");
      continue;
    }

    const missing = target - staked;
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
