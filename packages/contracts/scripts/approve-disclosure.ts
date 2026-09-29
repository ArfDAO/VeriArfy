/**
 * Yetkili dugumler adina bir acilim talebini onaylar.
 *
 * NEDEN ELLE: Bu depoda surekli calisan bir dugum servisi YOK. Arastirmaci
 * odemeyi yaptiginda zincirde bir acilim talebi acilir ama kimse onaylamaz;
 * talep `finalized=false, approvals=0` olarak asili kalir ve arayuz hakli
 * olarak "yetkili dugum onaylari bekleniyor" der. Odeme gecmis olmasi
 * onaylandi demek degildir - ikisi ayri adimdir.
 *
 * Onay vermek ekonomik sorumluluk gerektirir: dugum teminatli olmali
 * (`canApprove`). Teminat icin `bootstrap-nodes.ts`.
 *
 * Kullanim:
 *   REQUEST_ID=0 NODE_WALLETS=../../node-wallets.local.json \
 *   npx hardhat run scripts/approve-disclosure.ts --network sepolia
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { ethers, network } from "hardhat";

async function main() {
  const requestId = Number(process.env.REQUEST_ID ?? "0");
  if (!Number.isInteger(requestId) || requestId < 0) {
    throw new Error("REQUEST_ID gecerli bir sayi olmali");
  }

  const walletsEnv = process.env.NODE_WALLETS;
  if (!walletsEnv) throw new Error("NODE_WALLETS dosya yolu zorunludur");
  const walletsPath = isAbsolute(walletsEnv) ? walletsEnv : join(__dirname, "..", walletsEnv);
  const { nodes } = JSON.parse(readFileSync(walletsPath, "utf8")) as {
    nodes: { address: string; privateKey: string }[];
  };

  const record = JSON.parse(
    readFileSync(join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"),
  );
  const protocol = await ethers.getContractAt("VeriarfyProtocol", record.contracts.VeriarfyProtocol);
  const staking = await ethers.getContractAt("VeriarfyStaking", record.contracts.VeriarfyStaking);

  const before = await protocol.disclosureRequest(requestId);
  if (before.requester === ethers.ZeroAddress) {
    throw new Error(`Talep ${requestId} yok.`);
  }
  const required = await protocol.requiredApprovals(4);
  console.log(`Talep ${requestId}`);
  console.log(`  isteyen   : ${before.requester}`);
  console.log(`  onaylar   : ${before.approvals}/${required}`);
  console.log(`  finalized : ${before.finalized}\n`);

  if (before.finalized) {
    console.log("Zaten sonuclandirilmis - islem gonderilmedi.");
    return;
  }

  for (const node of nodes) {
    const address = ethers.getAddress(node.address);

    if (!(await protocol.isAuthorizedNode(address))) {
      console.log(`${address}: yetkili dugum degil - atlandi`);
      continue;
    }
    if (await protocol.hasApproved(requestId, address)) {
      console.log(`${address}: zaten onaylamis - atlandi`);
      continue;
    }
    if (!(await staking.canApprove(address))) {
      console.log(`${address}: teminat yetersiz - once bootstrap-nodes calistirin`);
      continue;
    }

    const signer = new ethers.Wallet(node.privateKey, ethers.provider);
    const tx = await protocol.connect(signer).approveDisclosure(requestId);
    console.log(`${address}: onay gonderildi ${tx.hash}`);
    await tx.wait();

    const state = await protocol.disclosureRequest(requestId);
    console.log(`  -> onaylar ${state.approvals}/${required}, finalized ${state.finalized}`);
    if (state.finalized) break;
  }

  const after = await protocol.disclosureRequest(requestId);
  console.log(`\nSonuc: onaylar ${after.approvals}/${required}, finalized ${after.finalized}`);
  if (after.finalized) {
    const end = await protocol.challengeWindowEnd(requestId).catch(() => null);
    const block = await ethers.provider.getBlockNumber();
    if (end !== null) {
      console.log(`Itiraz penceresi biter: blok ${end} (su an ${block})`);
    }
    console.log("Sonraki adim: itiraz penceresi kapandiktan sonra executeDisclosure.");
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
