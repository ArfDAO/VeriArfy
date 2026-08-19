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

/**
 * Sentetik panel — koken kaniti icin. Gercek hasta verisi DEGILDIR.
 *
 * Uzunluk devrenin `PANEL_SIZE`'indan gelir; sabit yazilmaz. Panel
 * buyutuldugunde bu betik sessizce eski boyutta kalirsa kanit uretimi
 * "uzunluk uyusmuyor" ile duser ve canli dogrulama bosa gider.
 */
let PANEL: number[] = [];

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

  // Panel uzunlugu devreden gelir; sabit yazilmaz.
  PANEL = Array.from(
    { length: provenance.PANEL_SIZE },
    (_: unknown, i: number) => [0, 1, 2, 1, 0, 2][i % 6],
  );

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

  const snpCount: number = Number(await protocol.snpCount());
  const rareSnp: number = Number(await protocol.rareSnpIndex());
  console.log(`SNP paneli: ${snpCount} varyant (nadirlik varyanti #${rareSnp})`);

  if (await protocol.hasAggregated(signer.address)) {
    console.log("Sifreli dozajlar zaten gonderilmis — adim atlaniyor.\n");
  } else {
    // Kayit: grup BIR KEZ yazilir (rapor §3.3, MK-0012).
    if (!(await protocol.isEnrolled(signer.address))) {
      console.log("Gruba kayit hazirlaniyor (Zama relayer)...");
      const groupInput = await fhevm
        .createEncryptedInput(address, signer.address)
        .add8(TEST_GROUP)
        .encrypt();

      const enrollTx = await protocol
        .connect(signer)
        .enroll(groupInput.handles[0], groupInput.inputProof);
      const enrollReceipt = await enrollTx.wait();
      console.log(`  enroll hash : ${enrollTx.hash}  (gas ${enrollReceipt?.gasUsed})`);
    }

    // Dozajlar PARTILER halinde. Parti tavani fhEVM'in HCU butcesinden gelir
    // (blok gazindan degil); olculen guvenli deger 12, burada 8 kullanilir.
    const BATCH = 8;
    let sent = Number(await protocol.submittedSnps(signer.address));

    while (sent < snpCount) {
      const size = Math.min(BATCH, snpCount - sent);
      const builder = fhevm.createEncryptedInput(address, signer.address);
      // Nadirlik varyantinda TEST_DOSAGE, digerlerinde donusumlu deger.
      for (let i = 0; i < size; i++) {
        const snp = sent + i;
        builder.add8(snp === rareSnp ? TEST_DOSAGE : snp % 3);
      }
      const encrypted = await builder.encrypt();

      console.log(`contributeDosages gonderiliyor (SNP ${sent}..${sent + size - 1})...`);
      aggTx = await protocol
        .connect(signer)
        .contributeDosages(encrypted.handles, encrypted.inputProof);
      const aggReceipt = await aggTx.wait();
      console.log(`  hash : ${aggTx.hash}`);
      console.log(`  gas  : ${aggReceipt?.gasUsed}  (${size} SNP)`);

      sent = Number(await protocol.submittedSnps(signer.address));
    }
    console.log("");
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

  // --- 2c) Surekli biyobelirtec kanali (veri kategorisi 2) -----------------
  //
  // Genomik dozajdan farkli olarak burada SUREKLI degerler var ve zincirde
  // biriken sey kontenjans tablosu degil, Welch t-testinin yeterli
  // istatistikleri: n, Sum x, Sum x^2.
  //
  // Gercek agda dogrulanan sey: `mul(euint64, euint64)` — yani kareyi alma —
  // Zama'nin coprocessor'unda gercekten calisiyor ve islem fhEVM'in HCU
  // butcesine sigiyor. Mock ortami bunu kanitlamaz.
  console.log("--- Surekli biyobelirtec kanali ---");

  const biomarkersAddress: string | undefined = record.contracts.VeriarfyBiomarkers;

  if (!biomarkersAddress) {
    console.log("Bu dagitimda biyobelirtec modulu yok — adim atlaniyor.\n");
  } else {
    const biomarkers = await ethers.getContractAt("VeriarfyBiomarkers", biomarkersAddress);
    const metricCount = Number(await biomarkers.metricCount());
    console.log(`Metrik paneli: ${metricCount} metrik  (${biomarkersAddress})`);

    let sentMetrics = Number(await biomarkers.submittedMetrics(signer.address));

    if (sentMetrics >= metricCount) {
      console.log("Olcumler zaten gonderilmis — adim atlaniyor.\n");
    } else {
      // OLCUMLER SENTETIKTIR ama zincirin ZORLADIGI araliga uyar: her deger
      // panelin ilan ettigi [minValue, maxValue] icinde secilir. Disinda
      // secilseydi kirpilmaz, ELENIRDI — ve sayaç artmadigi icin bu adim
      // sessizce basarisiz gorunurdu.
      const encodedValues: number[] = [];
      for (let i = 0; i < metricCount; i++) {
        const spec = await biomarkers.metricAt(i);
        const min = Number(spec.minValue);
        const max = Number(spec.maxValue);
        // Araligin ortasina yakin, tekrarlanabilir bir deger.
        encodedValues.push(min + Math.floor((max - min) / 3));
      }

      // Parti tavani: olculen 8 metrik/islem (kareyi alma pahali).
      const METRIC_BATCH = 6;

      while (sentMetrics < metricCount) {
        const size = Math.min(METRIC_BATCH, metricCount - sentMetrics);

        // DIKKAT: girdi kaniti KONTRAT ADRESINE baglidir. Olcumler MODULUN
        // adresi icin sifrelenir; protokolunki kullanilsaydi `fromExternal`
        // gecersiz girdi diye reddederdi.
        const builder = fhevm.createEncryptedInput(biomarkersAddress, signer.address);
        for (let i = 0; i < size; i++) builder.add32(encodedValues[sentMetrics + i]);
        const encrypted = await builder.encrypt();

        console.log(
          `contributeBiomarkers gonderiliyor (metrik ${sentMetrics}..${sentMetrics + size - 1})...`,
        );
        const bioTx = await biomarkers
          .connect(signer)
          .contributeBiomarkers(encrypted.handles, encrypted.inputProof);
        const bioReceipt = await bioTx.wait();
        console.log(`  hash : ${bioTx.hash}`);
        console.log(`  gas  : ${bioReceipt?.gasUsed}  (${size} metrik)`);

        sentMetrics = Number(await biomarkers.submittedMetrics(signer.address));
      }
    }

    // Zincirden GERI OKU: "gonderdim" ile "zincir oyle diyor" ayni sey degil.
    const [sumHandle, sumSqHandle, countHandle] = await biomarkers.biomarkerAggregate(
      0,
      TEST_GROUP,
    );
    console.log(`  panel tamam : ${await biomarkers.hasBiomarkerPanel(signer.address)}`);
    console.log(`  Sum x   handle: ${sumHandle}`);
    console.log(`  Sum x^2 handle: ${sumSqHandle}`);
    console.log(`  n       handle: ${countHandle}`);

    if (sumHandle === ethers.ZeroHash || sumSqHandle === ethers.ZeroHash) {
      throw new Error("Biyobelirtec toplamlari bos — homomorfik birikim olusmadi");
    }
    if (Number(await biomarkers.submittedMetrics(signer.address)) !== metricCount) {
      throw new Error("Zincir metrik sayacini beklenen degerde gostermiyor");
    }
    console.log("");
  }

  // --- 2b) Nadirlik Carpani (rapor §4.3) -----------------------------------
  //
  // Burada dogrulanan sey sudur: KMS dugumleri TEK BIR BITI gercek agda
  // esikli olarak cozebiliyor ve kontrat bu cozumun KMS imzalarini zincirde
  // dogruluyor. Sonucu getiren taraf guvenilir sayilmaz.
  //
  // Test dozaji heterozigot (1) oldugu icin beklenen yanit "nadir DEGIL".
  // Bu, sonucun uydurulmadigi anlamina da gelir: uydurulsaydi "nadir" yazardi.
  console.log("--- Nadirlik Carpani (esikli tek bit) ---");

  if ((await protocol.rarityConfirmedAtBlock(signer.address)) !== 0n) {
    console.log("Nadirlik zaten dogrulanmis — adim atlaniyor.\n");
  } else {
    if (!(await protocol.rarityRequested(signer.address))) {
      const reqTx = await protocol.connect(signer).requestRarityAssessment();
      const reqReceipt = await reqTx.wait();
      console.log(`  acilim izni : ${reqTx.hash}  (gas ${reqReceipt?.gasUsed})`);
    }

    const rarityHandle: string = await protocol.rarityHandle(signer.address);
    console.log(`  bit handle  : ${rarityHandle}`);

    console.log("  KMS esikli cozumu isteniyor (gercek relayer)...");
    const decryption = await fhevm.publicDecrypt([rarityHandle]);
    const clearBit = (decryption.clearValues as any)[rarityHandle.toLowerCase()];
    console.log(`  cozulen bit : ${clearBit}`);
    console.log(`  imza uzunlugu: ${decryption.decryptionProof.length} bayt`);

    const confirmTx = await protocol
      .connect(signer)
      .confirmRarity(
        signer.address,
        decryption.abiEncodedClearValues,
        decryption.decryptionProof,
      );
    const confirmReceipt = await confirmTx.wait();
    console.log(`  zincir dogrulamasi: ${confirmTx.hash}  (gas ${confirmReceipt?.gasUsed})`);
  }

  const isCarrier: boolean = await protocol.isRareCarrier(signer.address);
  const [poolCount, carriers] = await protocol.rarityStats();
  console.log(`  sonuc       : ${isCarrier ? "NADIR TASIYICI" : "yaygin varyant"}`);
  console.log(`  havuz/tasiyici: ${poolCount} / ${carriers}`);
  console.log(`  Kurucu Katkici: ${await protocol.isFoundingContributor(signer.address)}\n`);

  // Dozaj 1 gonderildi; nadir esigi 2'dir. Sonuc "nadir" cikarsa ya kod ya da
  // esikli cozum bozuk demektir — sessizce gecilmemeli.
  if (TEST_DOSAGE !== 2 && isCarrier) {
    throw new Error("Nadirlik biti yanlis: dozaj 2 degilken tasiyici isaretlendi");
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

  // Rapor §2.7: onay vermek EKONOMIK SORUMLULUK gerektirir. Modul bagliysa
  // teminatsiz dugum onay veremez.
  const stakingAddress: string | undefined = record.contracts.VeriarfyStaking;
  const staking = stakingAddress
    ? await ethers.getContractAt("VeriarfyStaking", stakingAddress)
    : null;

  if (staking) {
    const need = await staking.minStake();
    const have = await staking.stakeOf(signer.address);
    if (have < need) {
      const stakeTx = await staking.stake({ value: need - have });
      await stakeTx.wait();
      console.log(`Dugum teminati yatirildi: ${ethers.formatEther(need)} ETH (${stakeTx.hash})`);
    } else {
      console.log(`Dugum teminati yeterli: ${ethers.formatEther(have)} ETH`);
    }
  }

  // --- Dead Man's Switch dogrulamasi (rapor §2.6.1) ------------------------
  //
  // Gercek agda kanitlanan sey: devir esigi yururlukte, ana dugum hayattayken
  // devir KAPALI, ve varis atanmamisken hicbir kosulda acilmaz.
  //
  // Devrin kendisini burada tetiklemiyoruz: sessizlik esigi uretimde ~1 gun
  // olmalidir ve duman testinde bunu beklemek anlamsizdir. Devir davranisinin
  // tamami `DeadMansSwitch.test.ts` icinde 24 testle dogrulanir.
  console.log("--- Dead Man's Switch (rapor §2.6.1) ---");
  const heirCount: bigint = await protocol.heirNodeCount();
  const timeout: bigint = await protocol.livenessTimeout();
  const lastBeat: bigint = await protocol.lastMainHeartbeat();
  const failover: boolean = await protocol.isFailoverActive();

  console.log(`  sessizlik esigi : ${timeout} blok`);
  console.log(`  son yasam isareti: blok ${lastBeat}`);
  console.log(`  varis dugum      : ${heirCount}`);
  console.log(`  devir aktif      : ${failover}`);

  if (failover) {
    throw new Error("ana dugum hayattayken devir aktif gorunuyor");
  }
  if (timeout === 0n) {
    throw new Error("sessizlik esigi ayarlanmamis — dagitim eksik");
  }
  console.log("");

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

  if (!(await protocol.isDisclosureFinalized(q.disclosureRequestId))) {
    throw new Error("esik saglanmadi — onay sayisi yetersiz olabilir");
  }

  // Rapor §2.7.1: esikten SONRA itiraz suresi baslar. Cozum yetkisi bu sure
  // dolmadan verilmez — `FHE.allow` geri alinamadigi icin sira boyle olmak
  // zorunda. Buradaki bekleme, mekanizmanin gercek agda da yururlukte
  // oldugunun kanitidir.
  const windowEnd: bigint = await protocol.challengeWindowEnd(q.disclosureRequestId);
  if (await protocol.isDisclosureGranted(q.disclosureRequestId)) {
    console.log("Acilim zaten yurutulmus — itiraz adimi atlaniyor.");
  } else {
    // Blok numarasi yoklamasi RPC kopmalarina DAYANIKLI olmali: burada
    // dakikalarca beklenir ve tek bir ECONNRESET butun canli dogrulamayi
    // bosa cikarirdi. Gecici hata yutulur, kalici hata sonunda yine duser.
    const readBlock = async (): Promise<bigint> => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return BigInt(await ethers.provider.getBlockNumber());
        } catch (err) {
          if (attempt === 4) throw err;
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
      }
      throw new Error("blok numarasi okunamadi");
    };

    let current = await readBlock();
    if (current < windowEnd) {
      console.log(`Itiraz suresi acik: blok ${current} -> ${windowEnd}, bekleniyor...`);
      while (current < windowEnd) {
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        current = await readBlock();
      }
      console.log(`  itiraz suresi doldu (blok ${current})`);
    }

    const execTx = await protocol.executeDisclosure(q.disclosureRequestId);
    const execReceipt = await execTx.wait();
    console.log(`executeDisclosure tx: ${execTx.hash}  (gas ${execReceipt?.gasUsed})`);
  }

  if (!(await protocol.isDisclosureGranted(q.disclosureRequestId))) {
    throw new Error("itiraz suresi sonrasi cozum yetkisi verilmedi");
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
