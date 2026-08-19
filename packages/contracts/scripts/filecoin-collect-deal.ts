import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ethers, network } from "hardhat";

/**
 * Saglayicinin yayimladigi anlasma kimligini toplar — rapor §2.9.2.
 *
 * Kullanim:
 *   npx hardhat --config hardhat.filecoin.ts run scripts/filecoin-collect-deal.ts --network calibration
 *
 * # Ne bekliyoruz
 *
 * `makeDealProposal` yalnizca bir TEKLIFTIR. Saglayici (Calibration'da
 * PiKNiK / t017840) teklifi gorup CAR'i indirir, anlasmayi yayimlar ve market
 * aktoru sozlesmeyi geri cagirir. O geri cagri `pieceDeals[commP]` alanina
 * anlasma kimligini yazar.
 *
 * Bu betik o alani okur. Bos ise henuz yayimlanmamis demektir — hata degil,
 * bekleme. PiKNiK sektorleri 12 saatte bir kapatir.
 *
 * # Neden Sepolia'ya yazmiyor
 *
 * Yaziyor — ama ayri bir adimda: bu betik Calibration'a bagli kosar ve
 * Sepolia'ya ayni anda baglanamaz. Anlasma kimligi bulundugunda
 * `filecoin/deal-state.json` guncellenir; `filecoin-register-deal.ts` onu
 * Sepolia'daki kalicilik defterine isler.
 */

const STATE_PATH = join(__dirname, "..", "filecoin", "deal-state.json");

/** Filecoin market anlasmasinin durumunu herkese acik RPC'den okur. */
async function readMarketDeal(dealId: bigint) {
  const rpcUrl =
    process.env.FILECOIN_RPC_URL ?? "https://api.calibration.node.glif.io/rpc/v1";

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "Filecoin.StateMarketStorageDeal",
      params: [Number(dealId), null],
    }),
  });

  const body = (await response.json()) as any;
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

async function main() {
  if (network.name !== "calibration") {
    throw new Error(`Calibration bekleniyordu, ag: ${network.name}`);
  }
  if (!existsSync(STATE_PATH)) {
    throw new Error(`${STATE_PATH} yok. Once filecoin-make-deal.ts calistirin.`);
  }

  const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  const dealClient = await ethers.getContractAt("DealClient", state.dealClient);

  console.log(`DealClient : ${state.dealClient}`);
  console.log(`piece CID  : ${state.pieceCid}`);
  console.log(`teklif     : ${state.proposedAt}\n`);

  const dealId: bigint = await dealClient.pieceDeals(state.pieceCidHex);

  if (dealId === 0n) {
    // Bu bir HATA DEGIL: saglayici henuz sektoru kapatmamis olabilir.
    const elapsedMs = Date.now() - new Date(state.proposedAt).getTime();
    const hours = (elapsedMs / 3_600_000).toFixed(1);

    console.log(`Anlasma henuz yayimlanmadi (teklif uzerinden ${hours} saat gecti).`);
    console.log(
      "PiKNiK sektorleri 12 saatte bir kapatir; 24 saate kadar normaldir.\n" +
        "Teklif kimligi ile takip: " + state.proposalId,
    );

    if (elapsedMs > 48 * 3_600_000) {
      console.log(
        "\nUYARI: 48 saati asti. Olasi sebepler:\n" +
          "  - CAR genel adresten indirilemiyor (Pinata pini dustu mu?)\n" +
          "  - start_epoch gecti, teklif gecersizlesti\n" +
          "  - saglayici teklifi reddetti\n" +
          "Yeniden hazirlayip teklif acmak gerekebilir.",
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log(`ANLASMA YAYIMLANDI — dealId ${dealId}\n`);

  // Zincirdeki kaydi Filecoin'in KENDI RPC'sinden dogrula: sozlesmenin
  // sakladigi kimlik gercek bir anlasmaya mi denk geliyor?
  const deal = await readMarketDeal(dealId);
  const proposal = deal.Proposal;

  console.log(`  saglayici : ${proposal.Provider}`);
  console.log(`  piece CID : ${proposal.PieceCID["/"]}`);
  console.log(`  baslangic : ${proposal.StartEpoch}`);
  console.log(`  bitis     : ${proposal.EndEpoch}`);
  console.log(`  sure      : ${proposal.EndEpoch - proposal.StartEpoch} epoch`);
  console.log(`  sektor    : ${deal.State.SectorStartEpoch}`);

  if (proposal.PieceCID["/"] !== state.pieceCid) {
    throw new Error(
      `Piece CID uyusmuyor: bekledigimiz ${state.pieceCid}, gelen ${proposal.PieceCID["/"]}`,
    );
  }

  const providerMatch = /^[ft]0(\d+)$/.exec(proposal.Provider);
  if (!providerMatch) throw new Error(`Saglayici adresi ayristirilamadi: ${proposal.Provider}`);

  writeFileSync(
    STATE_PATH,
    JSON.stringify(
      {
        ...state,
        dealId: dealId.toString(),
        providerId: providerMatch[1],
        actualStartEpoch: proposal.StartEpoch,
        actualEndEpoch: proposal.EndEpoch,
        publishedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  console.log(`\nDurum guncellendi: ${STATE_PATH}`);
  console.log(
    "\nSonraki adim — Sepolia'daki kalicilik defterine isle:\n" +
      "  npx hardhat run scripts/filecoin-register-deal.ts --network sepolia",
  );
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(`\nBasarisiz: ${err.message}`);
    process.exit(1);
  });
