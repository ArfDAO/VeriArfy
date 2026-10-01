/**
 * Yetkili dugum sayisini hedefe (varsayilan 10) cikarir.
 *
 * Rapor 2.6 esikleri "X/10" oranidir: 10 dugumde genel istatistik 4,
 * makine ogrenmesi 7, GWAS 9 onay ister (`requiredApprovals`).
 *
 * SIRA ONEMLI: once teminat, SONRA yetki. `requiredApprovals` yetkili dugum
 * SAYISINA bakar, onay verebilen dugum sayisina degil. Teminatsiz bir dugumu
 * yetkilendirmek esigi hemen yukseltir ama o dugum onay veremez; yeterince
 * boyle dugum olursa hicbir talep sonuclanamaz. Bu yuzden:
 *   1. Butun maliyet onceden hesaplanir; bakiye yetmezse HICBIR SEY yapilmaz.
 *   2. Yeni dugumler fonlanir ve teminat yatirir (`stake` yetki istemez).
 *   3. Yalnizca `canApprove` olan dugumler yetkilendirilir.
 *
 * Yeni anahtarlar `node-wallets.local.json` dosyasina eklenir (gitignore'da,
 * izin 600). Hosted dugum servisine `NODE_PRIVATE_KEYS` olarak verilmeli.
 *
 * Kullanim:
 *   NODE_WALLETS=../../node-wallets.local.json TARGET_NODES=10 STAKE_MULTIPLIER=2 \
 *   npx hardhat run scripts/add-nodes.ts --network sepolia
 *   (DRY_RUN=1 yalnizca maliyeti yazar)
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { ethers, network } from "hardhat";

const TARGET = Number(process.env.TARGET_NODES ?? 10);
const STAKE_MULTIPLIER = BigInt(process.env.STAKE_MULTIPLIER ?? "2");
/** Onay islemlerinin gazi icin dugumde birakilan tutar. */
const GAS_BUFFER = ethers.parseEther(process.env.NODE_GAS_BUFFER ?? "0.003");
/** Fonlama + teminat + yetki islemlerinin deployer'a gaz maliyeti icin pay. */
const DEPLOYER_RESERVE = ethers.parseEther("0.003");
const DRY_RUN = process.env.DRY_RUN === "1";

type NodeWallet = { address: string; privateKey: string };

async function main() {
  const walletsEnv = process.env.NODE_WALLETS;
  if (!walletsEnv) throw new Error("NODE_WALLETS dosya yolu zorunludur");
  const walletsPath = isAbsolute(walletsEnv) ? walletsEnv : join(__dirname, "..", walletsEnv);
  const file = JSON.parse(readFileSync(walletsPath, "utf8")) as { nodes: NodeWallet[] };

  const record = JSON.parse(readFileSync(join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const [deployer] = await ethers.getSigners();
  const protocol = await ethers.getContractAt("VeriarfyProtocol", record.contracts.VeriarfyProtocol);
  const staking = await ethers.getContractAt("VeriarfyStaking", record.contracts.VeriarfyStaking);

  // 1) Eksik cuzdanlari uret ve HEMEN kaydet: islem yarida kalsa bile fonlanan
  //    bir adresin anahtari kaybolmasin.
  const created: NodeWallet[] = [];
  while (file.nodes.length + created.length < TARGET) {
    const wallet = ethers.Wallet.createRandom();
    created.push({ address: wallet.address, privateKey: wallet.privateKey });
  }
  if (created.length > 0 && !DRY_RUN) {
    file.nodes.push(...created);
    writeFileSync(walletsPath, `${JSON.stringify(file, null, 2)}\n`);
    chmodSync(walletsPath, 0o600);
    console.log(`${created.length} yeni dugum cuzdani ${walletsPath} dosyasina eklendi.`);
  }
  const nodes = DRY_RUN ? [...file.nodes, ...created] : file.nodes;

  // 2) Maliyet.
  const required = await staking.minStake();
  const target = required * STAKE_MULTIPLIER;
  const plan: { node: NodeWallet; stake: bigint; fund: bigint; authorize: boolean }[] = [];
  let total = 0n;
  for (const node of nodes) {
    const address = ethers.getAddress(node.address);
    const [staked, balance, authorized] = await Promise.all([
      staking.stakeOf(address),
      ethers.provider.getBalance(address),
      protocol.isAuthorizedNode(address),
    ]);
    const stake = staked >= target ? 0n : target - staked;
    const fund = stake + GAS_BUFFER > balance ? stake + GAS_BUFFER - balance : 0n;
    plan.push({ node, stake, fund, authorize: !authorized });
    total += fund;
  }

  const available = await ethers.provider.getBalance(deployer.address);
  console.log(`minStake ${ethers.formatEther(required)} ETH, hedef teminat ${ethers.formatEther(target)} ETH (${STAKE_MULTIPLIER}x)`);
  for (const step of plan) {
    console.log(
      `  ${step.node.address}  teminat +${ethers.formatEther(step.stake)}  fon +${ethers.formatEther(step.fund)}${step.authorize ? "  (yetkilendirilecek)" : ""}`,
    );
  }
  console.log(`Gereken ${ethers.formatEther(total + DEPLOYER_RESERVE)} ETH, deployer'da ${ethers.formatEther(available)} ETH`);

  if (DRY_RUN) return;
  if (available < total + DEPLOYER_RESERVE) {
    throw new Error(
      `Bakiye yetersiz: ${ethers.formatEther(total + DEPLOYER_RESERVE - available)} ETH eksik. Hicbir islem gonderilmedi.`,
    );
  }

  // 3) Fon + teminat.
  for (const step of plan) {
    if (step.fund > 0n) {
      const tx = await deployer.sendTransaction({ to: step.node.address, value: step.fund });
      await tx.wait();
      console.log(`  ${step.node.address} fonlandi ${tx.hash}`);
    }
    if (step.stake > 0n) {
      const signer = new ethers.Wallet(step.node.privateKey, ethers.provider);
      const tx = await staking.connect(signer).stake({ value: step.stake });
      await tx.wait();
      console.log(`  ${step.node.address} teminat ${tx.hash}`);
    }
  }

  // 4) Yetki - yalnizca onay verebilen dugumlere.
  for (const step of plan) {
    if (!step.authorize) continue;
    if (!(await staking.canApprove(step.node.address))) {
      console.log(`  ${step.node.address} canApprove=false - YETKILENDIRILMEDI`);
      continue;
    }
    const tx = await protocol.authorizeNode(step.node.address);
    await tx.wait();
    console.log(`  ${step.node.address} yetkilendirildi ${tx.hash}`);
  }

  console.log(`\nYetkili dugum: ${await protocol.authorizedNodeCount()}`);
  for (const [name, type] of [["genel istatistik", 4], ["makine ogrenmesi", 2], ["GWAS", 1]] as const) {
    console.log(`  ${name}: ${await protocol.requiredApprovals(type)} onay`);
  }
  console.log(`Deployer bakiye: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
