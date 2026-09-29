/**
 * Odeme tokenini degistirir: Payments'i yeniden dagitip zincire baglar.
 *
 * NEDEN AYRI BIR BETIK: `VeriarfyPayments.token` `immutable`. Sebebi mesru -
 * kullanicilarin hangi para biriminde odedigi sonradan degistirilememeli.
 * Ama bu, token degisikliginin Payments'i yeniden dagitmayi gerektirdigi
 * anlamina geliyor; ve yeni Payments'in Protocol'de sorgu kapisi, Staking'de
 * deger kaynagi olarak TANITILMASI sart. Uc adimdan biri atlanirsa sistem
 * derlenir, dagitilir ve sessizce calismaz:
 *   - setQueryGateway yapilmazsa `requestDisclosureFields` NotQueryGateway ile doner
 *   - setPayments yapilmazsa minStake() havuz degerine gore olceklenmeyi birakir
 *
 * ESKI PAYMENTS'TA BAKIYE VARSA DURUR. Katilimci alacaklari eski kontratta
 * kalir ve yeni kontrat onlari bilmez; sessizce gecmek parayi erisilemez
 * kilardi.
 *
 * Kullanim:
 *   PAYMENT_TOKEN=0x... npx hardhat run scripts/swap-payment-token.ts --network sepolia
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ethers, network } from "hardhat";

async function main() {
  const tokenAddress = process.env.PAYMENT_TOKEN;
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    throw new Error("PAYMENT_TOKEN gecerli bir adres olmali");
  }

  const deploymentPath = join(__dirname, "..", "deployments", `${network.name}.json`);
  const record = JSON.parse(readFileSync(deploymentPath, "utf8"));
  const [deployer] = await ethers.getSigners();

  const protocol = await ethers.getContractAt("VeriarfyProtocol", record.contracts.VeriarfyProtocol);
  const staking = await ethers.getContractAt("VeriarfyStaking", record.contracts.VeriarfyStaking);
  const oldPayments = await ethers.getContractAt("VeriarfyPayments", record.contracts.VeriarfyPayments);

  // Token gercekten ERC-20 mi ve ondaligi ayni mi? Ondalik sapmasi fiyat
  // sabitlerini sessizce 10^n kat kaydirir - en pahali hata turu.
  const token = await ethers.getContractAt("StableTestToken", tokenAddress);
  const symbol = await token.symbol();
  const decimals = await token.decimals();
  const oldDecimals = await (await ethers.getContractAt("StableTestToken", await oldPayments.token())).decimals();
  console.log(`Yeni token : ${tokenAddress} (${symbol}, ${decimals} ondalik)`);
  if (decimals !== oldDecimals) {
    throw new Error(
      `Ondalik uyusmuyor: eski ${oldDecimals}, yeni ${decimals}. Fiyat sabitleri ` +
        "bu varsayima gore yazildi; once QUERY_BASE_FEE/QUERY_PER_RECORD_FEE ayarlanmali.",
    );
  }

  const stranded = await token.balanceOf(record.contracts.VeriarfyPayments).catch(() => 0n);
  const oldToken = await ethers.getContractAt("StableTestToken", await oldPayments.token());
  const strandedOld = await oldToken.balanceOf(record.contracts.VeriarfyPayments);
  if (stranded > 0n || strandedOld > 0n) {
    throw new Error(
      `Eski Payments'ta bakiye var (${strandedOld} eski token, ${stranded} yeni token). ` +
        "Once alacaklar tahsil edilmeli; aksi halde bu para erisilemez hale gelir.",
    );
  }

  const liquidityShareBps = await oldPayments.liquidityShareBps();
  const baseFee = await oldPayments.baseFee();
  const perRecordFee = await oldPayments.perRecordFee();
  console.log(`Parametreler: pay %${Number(liquidityShareBps) / 100}, taban ${baseFee}, kayit basi ${perRecordFee}\n`);

  const Payments = await ethers.getContractFactory("VeriarfyPayments");
  const payments = await Payments.deploy(
    deployer.address,
    tokenAddress,
    record.contracts.VeriarfyProtocol,
    record.contracts.VeriArfyRegistry,
    liquidityShareBps,
    baseFee,
    perRecordFee,
  );
  await payments.waitForDeployment();
  const paymentsAddress = await payments.getAddress();
  console.log(`Yeni Payments: ${paymentsAddress}`);

  await (await protocol.setQueryGateway(paymentsAddress)).wait();
  console.log("  sorgu kapisi baglandi (protocol -> payments)");

  await (await staking.setPayments(paymentsAddress)).wait();
  console.log("  staking deger kaynagi baglandi");

  record.contracts.VeriarfyPayments = paymentsAddress;
  record.contracts.PaymentToken = tokenAddress;
  record.paymentTokenIsTestToken = false;
  record.paymentTokenSymbol = symbol;
  writeFileSync(deploymentPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nAdresler yazildi: deployments/${network.name}.json`);

  // Dogrulama: uc baglantinin da zincirde gecerli oldugunu OKUYARAK teyit et.
  console.log("\n--- dogrulama ---");
  console.log("protocol.queryGateway :", await protocol.queryGateway());
  console.log("staking.payments      :", await staking.payments());
  console.log("payments.token        :", await payments.token());
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
