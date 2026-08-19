import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ethers, network } from "hardhat";

/**
 * Calibration'da depolama anlasmasi teklifi acar — rapor §2.9.2.
 *
 * Onkosul: `node scripts/filecoin-prepare-car.mjs` calistirilmis olmali
 * (CAR hazir, commP hesaplanmis, genel adres dogrulanmis).
 *
 * Kullanim:
 *   npx hardhat --config hardhat.filecoin.ts run scripts/filecoin-make-deal.ts --network calibration
 *
 * # Akis
 *
 *   makeDealProposal -> DealProposalCreate olayi
 *      |
 *      +-- PiKNiK (t017840) botu olayi gorur, CAR'i indirir
 *      +-- anlasmayi Filecoin'de yayimlar   (~12-24 saat)
 *      +-- market aktoru sozlesmeyi geri cagirir -> pieceDeals[commP] = dealId
 *
 * Sonraki adim `filecoin-collect-deal.ts`: dealId'yi bekler ve Sepolia'daki
 * kalicilik defterine isler.
 */

const FILECOIN_DIR = join(__dirname, "..", "filecoin");
const INPUT_PATH = join(FILECOIN_DIR, "deal-input.json");
const STATE_PATH = join(FILECOIN_DIR, "deal-state.json");

/**
 * Teklifin baslangicina birakilan pay (epoch).
 *
 * Saglayicinin teklifi gormesi, CAR'i indirmesi ve sektoru muhurlemesi zaman
 * alir. `start_epoch` cok yakin verilirse anlasma "start epoch gecti" diye
 * duser. PiKNiK sektorleri 12 saatte bir kapattigi icin en az bir tam dongu
 * arti pay birakilir: 3 gun.
 */
const START_BUFFER_EPOCHS = 2_880 * 3;

/** 180 gun — `VeriarfyStorage.MIN_DEAL_EPOCHS` ile ayni (rapor WBS 2.3). */
const DEAL_DURATION_EPOCHS = 518_400;

async function main() {
  if (network.name !== "calibration") {
    throw new Error(`Calibration bekleniyordu, ag: ${network.name}`);
  }
  if (!existsSync(INPUT_PATH)) {
    throw new Error(`${INPUT_PATH} yok. Once: node scripts/filecoin-prepare-car.mjs`);
  }

  const input = JSON.parse(readFileSync(INPUT_PATH, "utf8"));
  const [signer] = await ethers.getSigners();

  console.log(`Ag        : ${network.name}`);
  console.log(`Gonderen  : ${signer.address}`);
  console.log(`Bakiye    : ${ethers.formatEther(await ethers.provider.getBalance(signer.address))} tFIL`);
  console.log(`piece CID : ${input.pieceCid}`);
  console.log(`CAR       : ${input.carUrl}\n`);

  // --- 1) DealClient -------------------------------------------------------
  // Bir kez dagitilir; sonraki tekliflerde ayni sozlesme kullanilir.
  let state: any = existsSync(STATE_PATH)
    ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
    : {};

  let dealClient;
  if (state.dealClient) {
    dealClient = await ethers.getContractAt("DealClient", state.dealClient);
    console.log(`DealClient: ${state.dealClient} (mevcut)`);
  } else {
    const Factory = await ethers.getContractFactory("DealClient");
    dealClient = await Factory.deploy();
    await dealClient.waitForDeployment();
    state.dealClient = await dealClient.getAddress();
    console.log(`DealClient: ${state.dealClient} (yeni dagitildi)`);
  }

  // --- 2) Epoch penceresi --------------------------------------------------
  // Filecoin epoch'u zincirin kendi zaman damgasindan turetilir; Calibration
  // genesis'i 1.667.326.380'dir (gercek zincirden dogrulandi).
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("Blok okunamadi");

  const CALIBRATION_GENESIS = 1_667_326_380;
  const currentEpoch = Math.floor((Number(block.timestamp) - CALIBRATION_GENESIS) / 30);
  const startEpoch = currentEpoch + START_BUFFER_EPOCHS;
  const endEpoch = startEpoch + DEAL_DURATION_EPOCHS;

  console.log(`\nGuncel epoch : ${currentEpoch}`);
  console.log(`Baslangic    : ${startEpoch} (+${START_BUFFER_EPOCHS} epoch pay)`);
  console.log(`Bitis        : ${endEpoch} (${DEAL_DURATION_EPOCHS} epoch = 180 gun)`);

  // --- 3) Teklif -----------------------------------------------------------
  const dealRequest = {
    piece_cid: input.pieceCidHex,
    piece_size: input.pieceSize,
    // Dogrulanmis anlasma DataCap gerektirir; test icin gereksiz karmasiklik.
    verified_deal: false,
    label: input.rootCid,
    start_epoch: startEpoch,
    end_epoch: endEpoch,
    // Ucretsiz anlasma: saglayici test aginda bedava kabul eder ve boylece
    // istemci teminati (escrow) yatirmak gerekmez.
    storage_price_per_epoch: 0,
    provider_collateral: 0,
    client_collateral: 0,
    extra_params_version: 1,
    extra_params: {
      location_ref: input.carUrl,
      car_size: input.carSize,
      skip_ipni_announce: false,
      remove_unsealed_copy: false,
    },
  };

  console.log("\nmakeDealProposal gonderiliyor...");
  const tx = await dealClient.makeDealProposal(dealRequest);
  const receipt = await tx.wait();
  console.log(`  hash : ${tx.hash}`);
  console.log(`  blok : ${receipt?.blockNumber}`);
  console.log(`  gas  : ${receipt?.gasUsed}`);

  // Teklif kimligi olaydan okunur — takip bununla yapilir.
  let proposalId: string | undefined;
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = dealClient.interface.parseLog(log as any);
      if (parsed?.name === "DealProposalCreate") {
        proposalId = parsed.args.id as string;
      }
    } catch {
      // Bu sozlesmeye ait olmayan gunlukler yok sayilir.
    }
  }
  if (!proposalId) throw new Error("DealProposalCreate olayi bulunamadi");
  console.log(`  teklif kimligi: ${proposalId}`);

  state = {
    ...state,
    proposalId,
    pieceCid: input.pieceCid,
    pieceCidHex: input.pieceCidHex,
    pieceSize: input.pieceSize,
    carUrl: input.carUrl,
    carSize: input.carSize,
    rootCid: input.rootCid,
    startEpoch,
    endEpoch,
    proposedAt: new Date().toISOString(),
    proposalTx: tx.hash,
  };
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

  console.log(`\nDurum yazildi: ${STATE_PATH}`);
  console.log(
    "\nSimdi saglayici teklifi almali. PiKNiK sektorleri 12 saatte bir\n" +
      "kapatir; anlasma kimliginin olusmasi 12-24 saat surebilir.\n\n" +
      "Takip:\n" +
      "  npx hardhat --config hardhat.filecoin.ts run scripts/filecoin-collect-deal.ts --network calibration",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nBasarisiz: ${err.message}`);
    process.exit(1);
  });
