/**
 * Itiraz suresini (blok) ayarlar.
 *
 * NEDEN VAR: `FHE.allow` geri alinamaz. Esige ulasildiktan sonra ve yetki
 * verilmeden once, hatali ya da kotu niyetli bir onayin itirazla
 * durdurulabilecegi TEK an bu penceredir (bkz. docs/mimari/0008).
 *
 * SINIRLAR:
 *   - 0 REDDEDILIR. Mekanizma ortadan kalkar; itiraz yolu gosterilemez olur.
 *   - VOTING_PERIOD ve UNBONDING_DELAY'e gore ust sinir: dugum teminatini
 *     cekmek icin gereken sure (UNBONDING_DELAY), itiraz + oylama suresinden
 *     UZUN olmali. Aksi halde kotu onay veren dugum, itiraz sonuclanmadan
 *     parasini alip kacar ve kesinti anlamsizlasir.
 *
 * Degisiklik YALNIZCA ILERIYE DONUKTUR: pencere sonu talep esige ulastiginda
 * yaziliyor, yani zaten acik talepler eski surelerini korur.
 *
 * Kullanim:
 *   CHALLENGE_BLOCKS=5 npx hardhat run scripts/set-challenge-period.ts --network sepolia
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ethers, network } from "hardhat";

async function main() {
  const blocks = Number(process.env.CHALLENGE_BLOCKS);
  if (!Number.isInteger(blocks) || blocks < 1) {
    throw new Error("CHALLENGE_BLOCKS 1 veya daha buyuk bir tamsayi olmali (0 mekanizmayi kaldirir).");
  }

  const record = JSON.parse(
    readFileSync(join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"),
  );
  const protocol = await ethers.getContractAt("VeriarfyProtocol", record.contracts.VeriarfyProtocol);
  const staking = await ethers.getContractAt("VeriarfyStaking", record.contracts.VeriarfyStaking);

  const voting = await staking.VOTING_PERIOD();
  const unbonding = await staking.UNBONDING_DELAY();
  if (BigInt(blocks) + voting >= unbonding) {
    throw new Error(
      `itiraz (${blocks}) + oylama (${voting}) >= teminat cekme gecikmesi (${unbonding}). ` +
        "Kotu onay veren dugum itiraz sonuclanmadan teminatini cekebilirdi.",
    );
  }

  const before = await protocol.challengePeriod();
  if (before === BigInt(blocks)) {
    console.log(`Itiraz suresi zaten ${blocks} blok - islem gonderilmedi.`);
    return;
  }

  const tx = await protocol.setChallengePeriod(blocks);
  console.log(`Gonderildi: ${tx.hash}`);
  await tx.wait();

  const block = await ethers.provider.getBlock("latest");
  const prev = await ethers.provider.getBlock(block!.number - 100);
  const blockTime = (block!.timestamp - prev!.timestamp) / 100;

  console.log(`Itiraz suresi: ${before} -> ${await protocol.challengePeriod()} blok`);
  console.log(`Yaklasik bekleme: ${((blocks * blockTime) / 60).toFixed(1)} dakika (blok ~${blockTime.toFixed(1)} sn)`);
  console.log("Yalniz bundan sonra esige ulasan taleplere uygulanir.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
