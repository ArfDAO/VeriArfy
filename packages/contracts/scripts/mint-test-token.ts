/**
 * Test odeme tokenini (tUSD) dagitir.
 *
 * NEDEN GEREKLI: `deploy.ts` StableTestToken'i dagitiyor ama HIC BASMIYOR.
 * Yeni bir dagitimdan sonra `totalSupply` sifir kalir; arastirmaci hazirlik
 * listesinde "0.0 tUSD / gerekli 1.0 tUSD" gorur ve hicbir sorgu acamaz.
 * `mint` yalnizca sahibe acik oldugu icin kullanici bunu kendi cozemez -
 * hesap degistirmek de ise yaramaz, cunku sorun hesapta degil arzda.
 *
 * Kullanim:
 *   MINT_TO=0xabc...,0xdef... MINT_AMOUNT=10000 \
 *   npx hardhat run scripts/mint-test-token.ts --network sepolia
 *
 * MINT_TO verilmezse yalnizca deployer'a basar.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ethers, network } from "hardhat";

async function main() {
  const record = JSON.parse(
    readFileSync(join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"),
  );
  if (!record.paymentTokenIsTestToken) {
    throw new Error("Bu dagitim gercek bir odeme tokeni kullaniyor; mint edilemez.");
  }

  const [deployer] = await ethers.getSigners();
  const token = await ethers.getContractAt("StableTestToken", record.contracts.PaymentToken);

  const owner = await token.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Bu cuzdan token sahibi degil. Sahip: ${owner}`);
  }

  const decimals = await token.decimals();
  const amount = ethers.parseUnits(process.env.MINT_AMOUNT ?? "10000", decimals);

  const targets = (process.env.MINT_TO ?? deployer.address)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ethers.getAddress(entry));

  console.log(`Token : ${record.contracts.PaymentToken} (${await token.symbol()})`);
  console.log(`Miktar: ${ethers.formatUnits(amount, decimals)} her adres icin\n`);

  for (const target of targets) {
    const before = await token.balanceOf(target);
    const tx = await token.mint(target, amount);
    await tx.wait();
    const after = await token.balanceOf(target);
    console.log(
      `${target}  ${ethers.formatUnits(before, decimals)} -> ${ethers.formatUnits(after, decimals)}  (${tx.hash})`,
    );
  }

  console.log(`\ntoplam arz: ${ethers.formatUnits(await token.totalSupply(), decimals)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
