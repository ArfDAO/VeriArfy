import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ethers, network } from "hardhat";

/**
 * CIDv1 base32 cozumu — `multiformats` KULLANILMADAN.
 *
 * Neden elle: `multiformats` yalnizca ESM olarak yayinlanir, bu betik ise
 * hardhat altinda CJS olarak kosar ve ts-node dinamik `import()`'u `require`'a
 * indirger. Sonuc: paket bu baglamda hicbir sekilde yuklenemiyor.
 *
 * Cozulen sey dar ve iyi tanimli: Filecoin piece CID'i (commP) her zaman
 * CIDv1, base32, `fil-commitment-unsealed` (0xf101) codec ve
 * `sha2-256-trunc254-padded` (0x1012) multihash'idir; ozet daima 32 bayttir.
 * Genel amacli bir CID kutuphanesine gerek yok.
 *
 * Dogrulama olcutu (gercek anlasma #90000000):
 *   baga6ea4seaqkdi6ztbx4buyhb5sz7n4r5hqw3zzgvhclv24xajr6xswzcucxiaa
 *   -> 0xa1a3d9986fc0d3070f659fb791e9e16de726a9c4baeb970263ebcad915057400
 */
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

/** Sonraki varint'i okur; [deger, yeni konum] dondurur. */
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

/**
 * Zincirdeki Filecoin anlasma kayitlarini Filecoin'in KENDI zincirinden dogrular.
 *
 * # Neden bu betik var
 *
 * `VeriarfyStorage` iki farkli sey yapar ve guven modelleri ayridir:
 *
 *   - politika (3 replika, 180 gun, farkli saglayici) -> zincirde ZORLANIR,
 *   - "boyle bir anlasma gercekten var mi"            -> bir TANIK beyan eder.
 *
 * Ikincisini guvensiz yapmanin yolu bir Filecoin isik istemcisi ya da kopru
 * olurdu; ikisi de bu projenin kapsami disinda. Bunun yerine tanigin yalani
 * TESPIT EDILEBILIR kilindi: her kayit bir `dealId` tasir ve o anlasma
 * Filecoin'in **herkese acik** RPC'sinden sorgulanabilir.
 *
 * Yani bu betik bir "guzellik" degil, guven modelinin tasiyici parcasidir:
 * tanik uydurma bir anlasma kaydederse, hicbir kimlik bilgisi gerektirmeyen
 * bu kontrol onu yakalar.
 *
 * # Kullanim
 *
 *   npx hardhat run scripts/verify-storage-deals.ts --network sepolia
 *
 * Ortam degiskeni ile RPC degistirilebilir (varsayilan Glif genel ucu):
 *
 *   FILECOIN_RPC_URL=https://api.calibration.node.glif.io/rpc/v1
 */

/** Filecoin ana agi icin herkese acik, anahtar gerektirmeyen uc. */
const DEFAULT_RPC = "https://api.node.glif.io/rpc/v1";

interface FilecoinDealProposal {
  PieceCID: { "/": string };
  PieceSize: number;
  Client: string;
  Provider: string;
  StartEpoch: number;
  EndEpoch: number;
}

interface FilecoinDealState {
  SectorStartEpoch: number;
  LastUpdatedEpoch: number;
  SlashEpoch: number;
}

interface OnChainDeal {
  providerId: bigint;
  dealId: bigint;
  startEpoch: bigint;
  endEpoch: bigint;
  pieceCidDigest: string;
  terminated: boolean;
}

async function filecoinRpc(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  if (!response.ok) {
    throw new Error(`Filecoin RPC ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`Filecoin RPC hatasi: ${body.error.message}`);
  return body.result;
}

/** "f01234" -> 1234n. Aktor adresi baska bir bicimdeyse hata verir. */
function parseProviderId(address: string): bigint {
  const match = /^[ft]0(\d+)$/.exec(address);
  if (!match) {
    throw new Error(`Beklenmeyen saglayici adres bicimi: ${address}`);
  }
  return BigInt(match[1]);
}

/** Filecoin piece CID'ini (commP) 32 baytlik multihash ozetine cevirir. */
function pieceCidToDigest(pieceCid: string): string {
  // Base32 CID'ler 'b' coklu-taban onekiyle baslar.
  if (!pieceCid.startsWith("b")) {
    throw new Error(`Beklenen base32 CID degil: ${pieceCid}`);
  }

  const bytes = base32Decode(pieceCid.slice(1));

  if (bytes[0] !== 0x01) throw new Error(`CIDv1 bekleniyordu, surum: ${bytes[0]}`);

  let offset = 1;
  [, offset] = readVarint(bytes, offset); // codec — burada onemli degil
  [, offset] = readVarint(bytes, offset); // multihash algoritmasi
  const [digestLength, digestStart] = readVarint(bytes, offset);

  if (digestLength !== 32) {
    throw new Error(`32 baytlik ozet bekleniyordu, gelen: ${digestLength}`);
  }

  return ethers.hexlify(bytes.slice(digestStart, digestStart + digestLength));
}

/**
 * Betigin KENDISINI dogrular: epoch turetimi ve ayristirma gercek Filecoin
 * verisiyle sinanir.
 *
 * Neden gerekli: henuz kayitli anlasmamiz yokken bu betik hicbir sey
 * dogrulamadan "tamam" derdi. O halde bir gun gercek bir uyusmazlik ciktiginda
 * betigin dogru calistigina guvenemezdik. Burada, zincirdeki epoch hesabimiz
 * Filecoin'in GERCEK zincir basiyla karsilastirilir ve ayristirma yardimcilari
 * CANLI bir anlasma uzerinde denenir.
 */
async function selfCheck(rpcUrl: string, storage: any) {
  console.log("--- Oz-kontrol: betik dogru calisiyor mu ---");

  // 1) Epoch turetimi. Zincirimiz Filecoin epoch'unu `block.timestamp`'ten
  //    aritmetikle bulur; oracle yoktur. Dogru mu?
  const head = (await filecoinRpc(rpcUrl, "Filecoin.ChainHead", [])) as { Height: number };
  const ours = await storage.currentEpoch();
  const drift = BigInt(head.Height) - ours;

  console.log(`  Filecoin gercek epoch : ${head.Height}`);
  console.log(`  bizim hesabimiz       : ${ours}`);
  console.log(`  fark                  : ${drift} epoch`);

  // Ethereum blok zamani birkac saniye gecikebilir; 20 epoch (10 dk) tolerans.
  if (drift > 20n || drift < -20n) {
    throw new Error(
      `Epoch turetimi kayik (${drift} epoch). Genesis zaman damgasi yanlis olabilir.`,
    );
  }
  console.log("  epoch turetimi dogru (oracle kullanilmadan)\n");

  // 2) Ayristirma yardimcilari — CANLI bir anlasma uzerinde.
  const probeId = Number(process.env.FILECOIN_PROBE_DEAL ?? 90_000_000);
  const probe = (await filecoinRpc(rpcUrl, "Filecoin.StateMarketStorageDeal", [
    probeId,
    null,
  ])) as { Proposal: FilecoinDealProposal; State: FilecoinDealState };

  const providerId = parseProviderId(probe.Proposal.Provider);
  const pieceDigest = pieceCidToDigest(probe.Proposal.PieceCID["/"]);
  const duration = probe.Proposal.EndEpoch - probe.Proposal.StartEpoch;

  console.log(`  ornek anlasma #${probeId}`);
  console.log(`    saglayici  : ${probe.Proposal.Provider} -> ${providerId}`);
  console.log(`    piece ozeti: ${pieceDigest}`);
  console.log(`    sure       : ${duration} epoch (${duration / 2880} gun)`);

  if (providerId <= 0n) throw new Error("Saglayici ayristirilamadi");
  if (!/^0x[0-9a-f]{64}$/.test(pieceDigest)) {
    throw new Error(`Piece CID ozeti 32 bayt degil: ${pieceDigest}`);
  }

  // Sozlesmedeki 180 gun sabiti gercek agdaki anlasmalarla ortusuyor mu?
  const minEpochs = await storage.MIN_DEAL_EPOCHS();
  if (BigInt(duration) === minEpochs) {
    console.log(`    sure, sozlesmedeki 180 gun tabaniyla BIREBIR ayni\n`);
  } else {
    console.log(`    (sozlesme tabani ${minEpochs} epoch)\n`);
  }
}

/** Genel RPC'lerin blok araligi sinirina takilmadan olaylari toplar. */
async function collectDealEvents(storage: any, fromBlock: number) {
  const CHUNK = 45_000; // 50.000 sinirinin altinda guvenli pencere
  const head = await ethers.provider.getBlockNumber();
  const start = fromBlock > 0 ? fromBlock : Math.max(0, head - CHUNK);

  const filter = storage.filters.DealRegistered();
  const found: any[] = [];

  for (let cursor = start; cursor <= head; cursor += CHUNK) {
    const to = Math.min(cursor + CHUNK - 1, head);
    found.push(...(await storage.queryFilter(filter, cursor, to)));
  }
  return found;
}

async function main() {
  const rpcUrl = process.env.FILECOIN_RPC_URL ?? DEFAULT_RPC;

  const recordPath = join(__dirname, "..", "deployments", `${network.name}.json`);
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  const storageAddress: string | undefined = record.contracts.VeriarfyStorage;

  if (!storageAddress) {
    throw new Error(
      `${network.name} dagitiminda VeriarfyStorage yok. Once deploy calistirin.`,
    );
  }

  const storage = await ethers.getContractAt("VeriarfyStorage", storageAddress);

  console.log(`Ag           : ${network.name}`);
  console.log(`Depolama      : ${storageAddress}`);
  console.log(`Filecoin RPC  : ${rpcUrl}`);
  console.log(`Zincir epoch'u: ${await storage.currentEpoch()}\n`);

  await selfCheck(rpcUrl, storage);

  // Kayitli CID'ler zincirde bir liste olarak tutulmaz (sinirsiz dizi gaz
  // riskidir); olaylardan toplanir.
  //
  // Olaylar PARCALI okunur: genel RPC saglayicilari tek sorguda 50.000 bloktan
  // genis aralik kabul etmez. Baslangic noktasi dagitim blogudur — sozlesme
  // ondan once var olmadigi icin daha geriye bakmak bosuna istektir.
  const events = await collectDealEvents(storage, Number(record.deployedAtBlock ?? 0));
  if (events.length === 0) {
    console.log("Henuz hicbir anlasma kaydedilmemis — dogrulanacak kayit yok.");
    console.log("(Anlasma yapmak icin FIL bakiyesi olan bir Filecoin hesabi gerekir.)");
    return;
  }

  const cids = [...new Set(events.map((e: any) => e.args.cidDigest as string))];
  console.log(`${events.length} anlasma kaydi, ${cids.length} farkli CID.\n`);

  let checked = 0;
  let mismatches = 0;
  let unreachable = 0;

  for (const cidDigest of cids) {
    const deals: OnChainDeal[] = await storage.dealsOf(cidDigest);
    const [replicas, adequate, dueForRenewal] = await storage.persistenceStatus(cidDigest);

    console.log(`CID ${cidDigest.slice(0, 18)}…`);
    console.log(
      `  aktif replika: ${replicas}  yeterli: ${adequate}  yenileme: ${dueForRenewal}`,
    );

    for (const deal of deals) {
      const label = `  anlasma #${deal.dealId} (saglayici f0${deal.providerId})`;

      let proposal: FilecoinDealProposal;
      let state: FilecoinDealState;
      try {
        const result = (await filecoinRpc(rpcUrl, "Filecoin.StateMarketStorageDeal", [
          Number(deal.dealId),
          null,
        ])) as { Proposal: FilecoinDealProposal; State: FilecoinDealState };
        proposal = result.Proposal;
        state = result.State;
      } catch (err: any) {
        // Anlasma bulunamamasi CIDDI bir bulgudur: kayitli ama Filecoin'de
        // yok demektir. Ag hatasindan ayirt edilebilsin diye ayri sayilir.
        console.log(`${label}: SORGULANAMADI — ${err.message}`);
        unreachable += 1;
        continue;
      }

      checked += 1;
      const problems: string[] = [];

      const actualProvider = parseProviderId(proposal.Provider);
      if (actualProvider !== deal.providerId) {
        problems.push(`saglayici ${deal.providerId} yazilmis, gercekte ${actualProvider}`);
      }
      if (BigInt(proposal.StartEpoch) !== deal.startEpoch) {
        problems.push(`baslangic ${deal.startEpoch} yazilmis, gercekte ${proposal.StartEpoch}`);
      }
      if (BigInt(proposal.EndEpoch) !== deal.endEpoch) {
        problems.push(`bitis ${deal.endEpoch} yazilmis, gercekte ${proposal.EndEpoch}`);
      }

      const actualPiece = pieceCidToDigest(proposal.PieceCID["/"]);
      if (actualPiece.toLowerCase() !== deal.pieceCidDigest.toLowerCase()) {
        problems.push(`piece CID ozeti uyusmuyor (${proposal.PieceCID["/"]})`);
      }

      // Filecoin'de cezalandirilmis bir anlasma zincirimizde "aktif"
      // gorunuyorsa defter gercekle ortusmuyor demektir.
      const slashed = state.SlashEpoch >= 0;
      if (slashed && !deal.terminated) {
        problems.push(`Filecoin'de cezalandirilmis (epoch ${state.SlashEpoch}) ama dusurulmemis`);
      }

      if (problems.length === 0) {
        console.log(`${label}: dogrulandi`);
      } else {
        mismatches += 1;
        console.log(`${label}: UYUSMAZLIK`);
        for (const p of problems) console.log(`      - ${p}`);
      }
    }
    console.log("");
  }

  console.log(`Dogrulanan: ${checked}, uyusmazlik: ${mismatches}, sorgulanamayan: ${unreachable}`);

  if (mismatches > 0) {
    throw new Error(
      `${mismatches} anlasma kaydi Filecoin ile UYUSMUYOR — tanik yanlis beyanda bulunmus olabilir.`,
    );
  }
  if (unreachable > 0) {
    throw new Error(
      `${unreachable} anlasma sorgulanamadi. Ag hatasi olabilir; ama kayitli bir anlasma ` +
        `Filecoin'de YOKSA bu da ayni hatayi verir ve arastirilmalidir.`,
    );
  }

  console.log("\nTum kayitlar Filecoin zinciriyle ortusuyor.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nDogrulama basarisiz: ${err.message}`);
    process.exit(1);
  });
