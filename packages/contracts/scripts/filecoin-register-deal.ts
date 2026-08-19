import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ethers, network } from "hardhat";

/**
 * Yayimlanmis Filecoin anlasmasini Sepolia'daki kalicilik defterine isler.
 *
 * Onkosul: `filecoin-collect-deal.ts` anlasma kimligini bulmus olmali.
 *
 * Kullanim:
 *   npx hardhat run scripts/filecoin-register-deal.ts --network sepolia
 *
 * # Iki zincir neden ayri
 *
 * Anlasma Filecoin'de yasar, defter Sepolia'da. Ethereum Filecoin'in durumunu
 * goremedigi icin kaydi bir TANIK yazar (bkz. MK-0010). Tanigin yalani
 * `verify-storage-deals.ts` ile yakalanabilir; bu betik o kaydi olusturur.
 */

const STATE_PATH = join(__dirname, "..", "filecoin", "deal-state.json");

/** Base32 CIDv1 -> 32 baytlik multihash ozeti. */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Decode(input: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of input) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Gecersiz base32 karakteri: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function readVarint(bytes: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let position = offset;
  for (;;) {
    if (position >= bytes.length) throw new Error("Varint okunurken CID bitti");
    const byte = bytes[position++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, position];
}

function cidToDigest(cid: string): string {
  if (!cid.startsWith("b")) throw new Error(`Beklenen base32 CID degil: ${cid}`);
  const bytes = base32Decode(cid.slice(1));
  if (bytes[0] !== 0x01) throw new Error(`CIDv1 bekleniyordu, surum: ${bytes[0]}`);

  let offset = 1;
  [, offset] = readVarint(bytes, offset);
  [, offset] = readVarint(bytes, offset);
  const [length, start] = readVarint(bytes, offset);
  if (length !== 32) throw new Error(`32 baytlik ozet bekleniyordu: ${length}`);

  return ethers.hexlify(bytes.slice(start, start + length));
}

async function main() {
  if (network.name === "calibration") {
    throw new Error("Bu betik defterin bulundugu agda kosar (sepolia).");
  }
  if (!existsSync(STATE_PATH)) {
    throw new Error(`${STATE_PATH} yok. Once filecoin-make-deal.ts calistirin.`);
  }

  const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  if (!state.dealId) {
    throw new Error(
      "Anlasma henuz yayimlanmamis. Once:\n" +
        "  npx hardhat --config hardhat.filecoin.ts run scripts/filecoin-collect-deal.ts --network calibration",
    );
  }

  const recordPath = join(__dirname, "..", "deployments", `${network.name}.json`);
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  const storageAddress = record.contracts.VeriarfyStorage;
  if (!storageAddress) throw new Error("VeriarfyStorage dagitilmamis");

  const storage = await ethers.getContractAt("VeriarfyStorage", storageAddress);

  // Defterin anahtari, KULLANICI VERISININ CID ozetidir (protokoldeki
  // `userCIDs` ile ayni) — CAR'in ya da piece'in degil. Anlasma, kok CID'in
  // isaret ettigi veriyi saklar.
  const cidDigest = cidToDigest(state.rootCid);
  const pieceDigest = cidToDigest(state.pieceCid);

  console.log(`Defter     : ${storageAddress}`);
  console.log(`kok CID    : ${state.rootCid}`);
  console.log(`  ozet     : ${cidDigest}`);
  console.log(`piece CID  : ${state.pieceCid}`);
  console.log(`anlasma    : ${state.dealId} (saglayici f0${state.providerId})`);
  console.log(`epoch      : ${state.actualStartEpoch} -> ${state.actualEndEpoch}`);

  const duration = state.actualEndEpoch - state.actualStartEpoch;
  const minEpochs = await storage.MIN_DEAL_EPOCHS();
  console.log(`sure       : ${duration} epoch (taban ${minEpochs})`);
  if (BigInt(duration) < minEpochs) {
    throw new Error(`Anlasma 180 gunden kisa: ${duration} epoch — defter reddeder`);
  }

  console.log("\nregisterDeal gonderiliyor...");
  const tx = await storage.registerDeal(
    cidDigest,
    state.providerId,
    state.dealId,
    state.actualStartEpoch,
    state.actualEndEpoch,
    pieceDigest,
  );
  const receipt = await tx.wait();
  console.log(`  hash : ${tx.hash}`);
  console.log(`  gas  : ${receipt?.gasUsed}`);

  const [replicas, adequate, dueForRenewal] = await storage.persistenceStatus(cidDigest);
  console.log(`\nKalicilik durumu:`);
  console.log(`  aktif replika : ${replicas}`);
  console.log(`  esik saglandi : ${adequate} (3 farkli saglayici gerekir)`);
  console.log(`  yenileme      : ${dueForRenewal}`);

  if (!adequate) {
    console.log(
      "\nNOT: Calibration'da anlasmalari otomatik kabul eden TEK saglayici var\n" +
        "(PiKNiK). Bu yuzden test aginda en fazla 1 replika gosterilebilir.\n" +
        "3 replika kurali uretimde 3 ayri saglayiciyla saglanir — panel bunu\n" +
        "durustce 'esik alti' olarak gosterir.",
    );
  }

  console.log(
    "\nDogrulama:\n  npx hardhat run scripts/verify-storage-deals.ts --network sepolia",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nBasarisiz: ${err.message}`);
    process.exit(1);
  });
