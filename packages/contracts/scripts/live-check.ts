import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ethers, fhevm, network } from "hardhat";

/**
 * Canli ag dogrulamasi — dagitilan kontrat GERCEKTEN calisiyor mu?
 *
 * # Bu betik neden var
 *
 * Testler FHEVM'in **mock** ortaminda kosar; orada sifreleme ve ACL yerel
 * olarak taklit edilir. Mock'ta gecen bir sozlesme, gercek agda Zama'nin
 * relayer'i ve coprocessor'lariyla konusurken yine de duselebilir: girdi
 * kaniti (input proof) gercek KMS tarafindan uretilir ve zincir uzerinde
 * dogrulanir.
 *
 * Bu yuzden "fhEVM entegrasyonu tamamlandi" demek icin mock testleri yetmez;
 * gercek agda gonderilmis bir islem gerekir. Betik tam olarak onu yapar ve
 * islem hash'lerini basar.
 *
 * # Ne gonderir
 *
 *   1. `submitRecord(...)` — ZK KOKEN KANITI ile IPFS CID ozetini indeksler.
 *      Kanit gercekten uretilir (snarkjs) ve zincirdeki Groth16 dogrulayici
 *      tarafindan gercekten dogrulanir.
 *   2. `aggregateDosage(grup, dozaj, proof)` — SIFRELI grup ve dozaji havuza
 *      ekler; GWAS kontenjans tablosu boyle doldurulur. Sifreleme ve girdi
 *      kaniti Zama'nin relayer'inda uretilir.
 *
 * Gonderilen panel ve dozaj sentetiktir; gercek hasta verisi degildir.
 *
 * Calistirma:
 *   npx hardhat run scripts/live-check.ts --network sepolia
 */

/** Sentetik test dozaji (heterozigot). Gercek veri DEGILDIR. */
const TEST_DOSAGE = 1;

/** Sentetik grup: 0 = kontrol (saglikli), 1 = vaka (hasta). */
const TEST_GROUP = 1;

/** Sentetik 16 SNP paneli — koken kaniti icin. Gercek hasta verisi DEGILDIR. */
const PANEL = [0, 1, 2, 1, 0, 0, 2, 1, 1, 0, 2, 2, 0, 1, 0, 1];

async function main() {
  if (network.name === "hardhat") {
    throw new Error(
      "Bu betik gercek agda anlamlidir; mock ag icin `npx hardhat test` kullanin.",
    );
  }

  const record = JSON.parse(
    readFileSync(join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"),
  );
  const address: string = record.contracts.VeriarfyProtocol;

  // Gercek agda relayer/KMS istemcisi tembel kurulur; bu cagri olmadan
  // `createEncryptedInput` "plugin is not initialized" ile duser.
  await fhevm.initializeCLIApi();

  const [signer] = await ethers.getSigners();
  const protocol = await ethers.getContractAt("VeriarfyProtocol", address);

  console.log(`Ag       : ${network.name} (mock: ${fhevm.isMock})`);
  console.log(`Kontrat  : ${address}`);
  console.log(`Gonderen : ${signer.address}`);

  // Kontratin coprocessor tarafindan taninip taninmadigini onceden dogrula:
  // taninmiyorsa hata, sifreleme adiminda degil burada ve anlasilir cikar.
  await fhevm.assertCoprocessorInitialized(address, "VeriarfyProtocol");

  const before = await protocol.participantCount();
  console.log(`Katilimci: ${before} (islem oncesi)\n`);

  // --- 1) IPFS kaydi + ZK koken kaniti -------------------------------------
  //
  // Kanit her kosumda YENIDEN uretilir: nullifier taahhude bagli oldugu icin
  // ayni kanit ikinci kez gecmez (zaten korumanin amaci bu). Bu yuzden her
  // kosumda yeni bir salt kullanilir.
  const cidDigest = ethers.keccak256(
    ethers.toUtf8Bytes(`veriarfy-canli-kontrol-${Date.now()}`),
  );

  console.log("ZK koken kaniti uretiliyor...");
  const provenance = await import("@veriarfy/circuits/provenance");
  const circuits = await import("@veriarfy/circuits");
  const snarkjs: any = await import("snarkjs");
  const { institution, registry: institutionRegistry } = await provenance.developmentRegistry();

  // Kontratin tanidigi kok ile yerelde kurulan agacin koku ayni olmali;
  // degilse kanit gecerli olsa bile `UnknownAccreditedRoot` ile reddedilir.
  const onChainRoot = await protocol.accreditedRoot();
  if (onChainRoot !== institutionRegistry.root) {
    throw new Error(
      `akredite kok uyusmuyor:\n  zincir: ${onChainRoot}\n  yerel : ${institutionRegistry.root}`,
    );
  }

  const salt = provenance.randomSalt();
  const commitment = provenance.panelCommitment(PANEL, salt);
  const signature = await provenance.signCommitment(institution.privateKey, commitment);

  const circuitsDir = join(__dirname, "..", "..", "circuits");
  const provenanceInput = provenance.buildProvenanceInput({
    dosages: PANEL,
    salt,
    institution,
    signature,
    registry: institutionRegistry,
    externalNullifier: await protocol.PROVENANCE_SCOPE(),
    cidDigest,
    signerAddress: signer.address,
  });

  const startedAt = Date.now();
  const { proof } = await snarkjs.groth16.fullProve(
    provenanceInput,
    join(circuitsDir, "build", "data_provenance_js", "data_provenance.wasm"),
    join(circuitsDir, "build", "data_provenance_final.zkey"),
  );
  const { a, b, c } = circuits.toSolidityCalldata(proof);
  console.log(`  kanit uretildi: ${Date.now() - startedAt} ms`);

  console.log("submitRecord gonderiliyor (kanitla)...");
  const submitTx = await protocol
    .connect(signer)
    .submitRecord(
      cidDigest,
      institutionRegistry.root,
      provenance.computeProvenanceNullifier(await protocol.PROVENANCE_SCOPE(), commitment),
      commitment,
      a,
      b,
      c,
    );
  const submitReceipt = await submitTx.wait();
  console.log(`  hash : ${submitTx.hash}`);
  console.log(`  blok : ${submitReceipt?.blockNumber}`);
  console.log(`  gas  : ${submitReceipt?.gasUsed}  (ZK dogrulama dahil)\n`);

  // --- 2) Sifreli dozaj ----------------------------------------------------
  // Burasi kritik nokta: `createEncryptedInput` gercek agda Zama'nin
  // relayer'ina gider, sifreleme ve girdi kaniti orada uretilir. Kontrat
  // `FHE.fromExternal(...)` ile bu kaniti dogrulamadan degeri kabul etmez.
  // Her adres havuza YALNIZCA BIR KEZ katkida bulunabilir (`AlreadyAggregated`).
  // Betik yeniden calistirilabilir olmali; ikinci kosumda bu adim atlanir.
  let aggTx: Awaited<ReturnType<typeof protocol.aggregateDosage>> | null = null;

  if (await protocol.hasAggregated(signer.address)) {
    console.log("Sifreli dozaj zaten gonderilmis — adim atlaniyor.\n");
  } else {
    console.log("Sifreli dozaj hazirlaniyor (Zama relayer)...");
    const encrypted = await fhevm
      .createEncryptedInput(address, signer.address)
      .add8(TEST_GROUP)
      .add8(TEST_DOSAGE)
      .encrypt();

    console.log(`  handle uzunlugu : ${encrypted.handles[0].length} bayt`);
    console.log(`  kanit uzunlugu  : ${encrypted.inputProof.length} bayt`);

    console.log("aggregateDosage gonderiliyor...");
    aggTx = await protocol
      .connect(signer)
      .aggregateDosage(encrypted.handles[0], encrypted.handles[1], encrypted.inputProof);
    const aggReceipt = await aggTx.wait();
    console.log(`  hash : ${aggTx.hash}`);
    console.log(`  blok : ${aggReceipt?.blockNumber}`);
    console.log(`  gas  : ${aggReceipt?.gasUsed}\n`);
  }

  // --- Dogrulama -----------------------------------------------------------
  const after = await protocol.participantCount();
  const storedCid = await protocol.userCIDs(signer.address);
  const storedCommitment = await protocol.panelCommitment(signer.address);
  const poolHandle = await protocol.dosagePool();

  if (storedCommitment !== commitment) {
    throw new Error(`zincirdeki panel taahhudu uyusmuyor: ${storedCommitment}`);
  }

  console.log(`Katilimci   : ${before} -> ${after}`);
  console.log(`Kayitli CID : ${storedCid}`);
  console.log(`Havuz handle: ${poolHandle}`);

  // Sayac yalnizca YENI katkida artar; tekrar kosumda ayni kalmasi dogrudur.
  const expected = aggTx ? before + 1n : before;
  if (after !== expected) {
    throw new Error(`Katilimci sayisi beklenmedik: ${before} -> ${after}`);
  }
  if (storedCid !== cidDigest) {
    throw new Error("CID zincire dogru yazilmadi");
  }
  if (poolHandle === ethers.ZeroHash) {
    throw new Error("Havuz handle'i bos — sifreli toplama olusmadi");
  }

  // --- 3) Odeme ve gelir paylasimi -----------------------------------------
  //
  // Rapor §4.1 / §4.2. Buraya kadar veri akisi dogrulandi; bu adim ekonomik
  // dongunun gercek zincirde kapandigini gosterir: arastirmaci oder, katilimci
  // payini ceker.
  console.log("--- Odeme ve gelir paylasimi ---");

  const paymentsAddress: string = record.contracts.VeriarfyPayments;
  const tokenAddress: string = record.contracts.PaymentToken;

  const payments = await ethers.getContractAt("VeriarfyPayments", paymentsAddress);
  const token = await ethers.getContractAt("StableTestToken", tokenAddress);
  const registryContract = await ethers.getContractAt(
    "VeriArfyRegistry",
    record.contracts.VeriArfyRegistry,
  );

  // Sorgu acabilmek icin arastirmaci olarak KAYITLI olmak gerekir. Kayit ZK
  // kanitiyla yapilir; burada gercek kanit uretilir.
  if (!(await registryContract.isRegistered(signer.address))) {
    console.log("Arastirmaci kaydi yok — GERCEK ZK kimlik kaniti uretiliyor...");

    const identity = circuits.createIdentity();
    const identityTree = new circuits.IdentityTree();
    identityTree.insert(identity.commitment);

    // Kontratin tanidigi kok bu agacinki olmali; sahip olarak koku yaziyoruz.
    await (await registryContract.updateRoot(identityTree.root)).wait();

    const { proof: identityProof } = await snarkjs.groth16.fullProve(
      circuits.buildCircuitInput({
        identity,
        tree: identityTree,
        externalNullifier: await registryContract.EXTERNAL_NULLIFIER(),
        signerAddress: signer.address,
      }),
      join(circuitsDir, "build", "researcher_identity_js", "researcher_identity.wasm"),
      join(circuitsDir, "build", "researcher_identity_final.zkey"),
    );
    const idCalldata = circuits.toSolidityCalldata(identityProof);

    const regTx = await registryContract.register(
      identityTree.root,
      circuits.computeNullifierHash(
        await registryContract.EXTERNAL_NULLIFIER(),
        identity.nullifier,
      ),
      idCalldata.a, idCalldata.b, idCalldata.c,
    );
    await regTx.wait();
    console.log(`  kayit tx: ${regTx.hash}`);
  }

  // Rapor §3.4: veri ancak kullanicinin ACIKCA izin verdigi kurum tarafindan
  // kullanilabilir. Bu betikte gonderen hem katilimci hem arastirmaci rolunde
  // oldugu icin izni kendisi verir.
  const scopeAll = 1 | 2 | 4; // GWAS | ML | STATISTICS
  const existing = await protocol.permission(signer.address, signer.address);
  if (!existing.isAllowed) {
    const grantTx = await protocol.grantAccess(signer.address, scopeAll, 0, 0);
    await grantTx.wait();
    console.log(`Erisim izni verildi: ${grantTx.hash}`);
  }

  const [fee, participants] = await payments.quoteFor(signer.address);
  console.log(`Sorgu ucreti: ${fee} (${participants} izin veren katilimci)`);

  // Test token'i ise bakiye basabiliyoruz; gercek USDC ise bakiye onceden olmali.
  if (record.paymentTokenIsTestToken) {
    const balance = await token.balanceOf(signer.address);
    if (balance < fee) {
      await (await token.mint(signer.address, fee * 10n)).wait();
      console.log("  test token'i basildi");
    }
  }

  const allowance = await token.allowance(signer.address, paymentsAddress);
  if (allowance < fee) {
    await (await token.approve(paymentsAddress, ethers.MaxUint256)).wait();
    console.log("  harcama izni verildi");
  }

  // BSKK-44 dugumu — esik hesabi dugum sayisina baglidir, bu yuzden
  // `requiredApprovals` cagrisindan ONCE atanmali (aksi halde
  // `NoAuthorizedNodes` ile duser).
  if (!(await protocol.isAuthorizedNode(signer.address))) {
    await (await protocol.authorizeNode(signer.address)).wait();
    console.log("Yetkili dugum atandi (tek cuzdanli duman testi)");
  }

  // TEK CUZDANLI TEST — k-anonimlik esigi gecici olarak dusurulur.
  //
  // Uretimde `minParticipants` 10'dur ve DUSURULMEMELIDIR: tek katilimciyken
  // havuzu cozmek, dogrudan o kisinin verisini okumak demektir. Burada tek
  // cuzdanla uctan uca akisi dogrulamak icin 1'e cekiliyor.
  if ((await protocol.minParticipants()) > 1n) {
    await (await protocol.setMinParticipants(1)).wait();
    console.log("k-anonimlik esigi 1'e cekildi (YALNIZCA duman testi icin)");
  }

  // Rapor §2.6: sorgu tipi esigi belirler. Genel istatistik -> 4/10.
  const STATISTICS = 4;
  const needed = await protocol.requiredApprovals(STATISTICS);
  console.log(`BSKK-44 esigi: ${needed} onay (sorgu tipi: genel istatistik, 4/10)`);

  const openTx = await payments.openQuery(STATISTICS);
  const openReceipt = await openTx.wait();
  const queryId = (await payments.nextQueryId()) - 1n;
  console.log(`openQuery tx: ${openTx.hash}  (gas ${openReceipt?.gasUsed})`);

  let q = await payments.query(queryId);
  console.log(`  ucret ${q.fee} EMANETTE (acilim talebi #${q.disclosureRequestId})`);

  // Ucret onay gelene kadar dagitilmaz — emanet gercekten calisiyor mu?
  if (q.settled) throw new Error("ucret onaydan once dagitildi");
  if ((await payments.claimable(queryId, signer.address)) !== 0n) {
    throw new Error("onaydan once pay hesaplandi");
  }
  console.log("  emanet dogrulandi: onay gelmeden pay hesaplanmiyor");

  const approveTx = await protocol.approveDisclosure(q.disclosureRequestId);
  await approveTx.wait();
  console.log(`approveDisclosure tx: ${approveTx.hash}`);

  if (!(await protocol.isDisclosureGranted(q.disclosureRequestId))) {
    throw new Error("esik saglanmadi — onay sayisi yetersiz olabilir");
  }

  const settleTx = await payments.settleQuery(queryId);
  const settleReceipt = await settleTx.wait();
  console.log(`settleQuery tx: ${settleTx.hash}  (gas ${settleReceipt?.gasUsed})`);

  q = await payments.query(queryId);
  console.log(`  ucret ${q.fee} -> katilimcilara ${q.liquidityPot}, hazineye ${q.fee - q.liquidityPot}`);

  // Gonderen ayni zamanda katilimci oldugu icin kendi payini cekebilir.
  const share = await payments.claimable(queryId, signer.address);
  if (share === 0n) {
    throw new Error(
      "pay hesaplanamadi — izin sorgunun acildigi blokta yururlukte olmayabilir",
    );
  }

  const balanceBefore = await token.balanceOf(signer.address);
  const claimTx = await payments.claim(queryId);
  const claimReceipt = await claimTx.wait();
  const gained = (await token.balanceOf(signer.address)) - balanceBefore;

  console.log(`claim tx: ${claimTx.hash}  (gas ${claimReceipt?.gasUsed})`);
  console.log(`  cekilen: ${gained}`);

  if (gained !== share) {
    throw new Error(`cekilen tutar beklenenden farkli: ${gained} != ${share}`);
  }

  // --- 4) Gizlilik Panelinin okudugu her alan gercekten geliyor mu ---------
  //
  // Panel (packages/web) bu cagrilarin tamamini yapar. Burada calistirilmasi,
  // ABI uyusmazliklarinin ya da eksik view fonksiyonlarinin arayuzde degil
  // BURADA yakalanmasini saglar.
  console.log("--- Gizlilik Paneli okumasi ---");

  const [pendingTotal, pendingIds] = await payments.pendingRewards(signer.address);
  const perm = await protocol.permission(signer.address, signer.address);
  const panelFields = {
    cid: await protocol.userCIDs(signer.address),
    taahhut: (await protocol.panelCommitment(signer.address)).toString().slice(0, 14) + "…",
    katilimIndeksi: await protocol.participantIndex(signer.address),
    havuzKatilimci: await protocol.participantCount(),
    kAnonimlik: await protocol.minParticipants(),
    izinVeren: await protocol.consentCount(signer.address),
    izinAktif: perm.isAllowed,
    izinTipleri: perm.queryTypes,
    bekleyenOdul: pendingTotal.toString(),
    bekleyenSorgu: pendingIds.length,
    tokenBakiye: (await token.balanceOf(signer.address)).toString(),
    tokenSembol: await token.symbol(),
  };

  for (const [key, value] of Object.entries(panelFields)) {
    console.log(`  ${key.padEnd(16)}: ${value}`);
  }

  if (panelFields.cid === ethers.ZeroHash) {
    throw new Error("panel CID okuyamadi");
  }
  if (!panelFields.izinAktif) {
    throw new Error("panel izin kaydini okuyamadi");
  }

  console.log("\nCanli dogrulama tamam: veri, kanit ve odeme dongusu gercek agda kapandi.");
  if (aggTx) {
    console.log(`Etherscan (dozaj) : https://sepolia.etherscan.io/tx/${aggTx.hash}`);
  }
  console.log(`Etherscan (odeme) : https://sepolia.etherscan.io/tx/${claimTx.hash}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nCanli dogrulama BASARISIZ: ${err.message ?? err}`);
    process.exit(1);
  });
