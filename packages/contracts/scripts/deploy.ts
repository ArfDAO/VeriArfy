import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ethers, network } from "hardhat";

/**
 * Calisma kontratlarini deploy eder:
 *   Groth16Verifier -> VeriArfyRegistry -> AnxietyStudy
 *
 * Baslangic koku, kurator agacindan (packages/curator/data/tree.json) okunur;
 * yoksa bos agac koku kullanilir ve sonra `push-root` ile guncellenir.
 */
async function main() {
  const { IdentityTree } = await import("@veriarfy/circuits");

  const [deployer] = await ethers.getSigners();
  console.log(`Ag: ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);

  // Kurator agacindan baslangic kokunu turet.
  const tree = new IdentityTree();
  const curatorStore = join(
    __dirname,
    "..",
    "..",
    "curator",
    "data",
    "tree.json",
  );
  if (existsSync(curatorStore)) {
    const { commitments } = JSON.parse(readFileSync(curatorStore, "utf8"));
    for (const c of commitments ?? []) tree.insert(BigInt(c));
    console.log(`Kurator agaci: ${commitments?.length ?? 0} taahhut`);
  }
  const initialRoot = tree.root;

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  console.log(`Groth16Verifier: ${verifierAddress}`);

  const Registry = await ethers.getContractFactory("VeriArfyRegistry");
  const registry = await Registry.deploy(verifierAddress, initialRoot);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log(`VeriArfyRegistry: ${registryAddress}`);

  const Study = await ethers.getContractFactory("AnxietyStudy");
  const study = await Study.deploy(registryAddress);
  await study.waitForDeployment();
  const studyAddress = await study.getAddress();
  console.log(`AnxietyStudy: ${studyAddress}`);

  // Veri kokeni dogrulayicisi — `data_provenance` devresi icin.
  const ProvenanceVerifier = await ethers.getContractFactory("DataProvenanceVerifier");
  const provenanceVerifier = await ProvenanceVerifier.deploy();
  await provenanceVerifier.waitForDeployment();
  const provenanceVerifierAddress = await provenanceVerifier.getAddress();
  console.log(`DataProvenanceVerifier: ${provenanceVerifierAddress}`);

  // Akredite kurumlar agaci.
  //
  // URETIMDE: kurumlarin ACIK anahtarlari toplanir, agac zincir disinda
  // kurulur ve yalnizca koku buraya yazilir. Burada kullanilan gelistirme
  // kurumu sabit bir tohumdan turetilir ve GIZLI DEGILDIR —
  // bkz. packages/circuits/src/provenance.js, `developmentInstitution`.
  const { developmentRegistry } = await import("@veriarfy/circuits/provenance");
  const { registry: institutionRegistry } = await developmentRegistry();
  console.log(`Akredite kurum agaci: 1 kurum (GELISTIRME anahtari)`);

  // VeriarfyProtocol — sifreli havuz + IPFS indeksi + esikli cozum.
  // Sahip olarak deployer atanir; URETIMDE bu adres cok imzali bir cuzdan olmali.
  // Esik ve k-anonimlik siniri ortam degiskenleriyle verilebilir.
  const threshold = Number(process.env.DISCLOSURE_THRESHOLD ?? 2);
  const minParticipants = Number(process.env.MIN_PARTICIPANTS ?? 10);

  // KUTUPHANE BAGLAMA.
  //
  // Protokol ve biyobelirtec modulu, EIP-170'in 24.576 baytlik kod sinirini
  // asmamak icin agir homomorfik dongulerini `public` kutuphanelere tasiyor.
  // Bu kutuphaneler ayri birer adrese dagitilir ve `delegatecall` ile
  // cagrilir; adresleri fabrikaya BAGLANMAZSA dagitim duser.
  const Contingency = await ethers.getContractFactory("ContingencyStats");
  const contingency = await Contingency.deploy();
  await contingency.waitForDeployment();
  const contingencyAddress = await contingency.getAddress();
  console.log(`ContingencyStats (kutuphane): ${contingencyAddress}`);

  const Protocol = await ethers.getContractFactory("VeriarfyProtocol", {
    libraries: { ContingencyStats: contingencyAddress },
  });
  const protocol = await Protocol.deploy(
    deployer.address,
    threshold,
    minParticipants,
    provenanceVerifierAddress,
    institutionRegistry.root,
  );
  await protocol.waitForDeployment();
  const protocolAddress = await protocol.getAddress();
  console.log(`VeriarfyProtocol: ${protocolAddress} (esik ${threshold}, min ${minParticipants} katilimci)`);

  // --- Odeme katmani -------------------------------------------------------
  //
  // Odeme token'i: URETIMDE gercek USDC adresi `PAYMENT_TOKEN` ile verilir.
  // Verilmezse test aglari icin gercek bir OZ ERC-20 dagitilir (mock degil —
  // yalnizca Circle'in bastigi USDC yerine bizim bastigimiz token).
  let paymentTokenAddress = process.env.PAYMENT_TOKEN ?? "";
  let deployedTestToken = false;

  if (!paymentTokenAddress) {
    const Token = await ethers.getContractFactory("StableTestToken");
    const token = await Token.deploy(deployer.address);
    await token.waitForDeployment();
    paymentTokenAddress = await token.getAddress();
    deployedTestToken = true;
    console.log(`StableTestToken: ${paymentTokenAddress}  (PAYMENT_TOKEN verilmedi)`);
  } else {
    console.log(`Odeme token'i (disaridan): ${paymentTokenAddress}`);
  }

  // Fiyatlandirma: 6 ondalikli token varsayilir (USDC ile ayni).
  const baseFee = BigInt(process.env.QUERY_BASE_FEE ?? 10_000_000); // 10 USDC
  const perParticipantFee = BigInt(process.env.QUERY_PER_PARTICIPANT_FEE ?? 1_000_000); // 1 USDC
  const liquidityShareBps = Number(process.env.LIQUIDITY_SHARE_BPS ?? 8_000); // %80

  const Payments = await ethers.getContractFactory("VeriarfyPayments");
  const payments = await Payments.deploy(
    deployer.address,
    paymentTokenAddress,
    protocolAddress,
    registryAddress,
    liquidityShareBps,
    baseFee,
    perParticipantFee,
  );
  await payments.waitForDeployment();
  const paymentsAddress = await payments.getAddress();
  console.log(
    `VeriarfyPayments: ${paymentsAddress} ` +
      `(katilimci payi %${liquidityShareBps / 100}, taban ${baseFee}, kisi basi ${perParticipantFee})`,
  );

  // --- Calisma tanimlari ---------------------------------------------------
  //
  // `study/deploy-env.json`, `packages/web/scripts/prepare-study.ts` tarafindan
  // uretilir: panel ozetleri ORADA, panelin kendisiyle ayni yerde hesaplanir ki
  // ikisi birbirinden sapamasin. Dosya yoksa ortam degiskenlerine dusulur.
  const studyEnvPath = join(__dirname, "..", "study", "deploy-env.json");
  const studyEnv: Record<string, string> = existsSync(studyEnvPath)
    ? JSON.parse(readFileSync(studyEnvPath, "utf8"))
    : {};

  if (Object.keys(studyEnv).length > 0) {
    console.log(`\nCalisma tanimlari: study/deploy-env.json (${studyEnv.preparedAt})`);
  }

  const pick = (key: string, fallback = "") =>
    process.env[key] ?? studyEnv[key] ?? fallback;

  // --- SNP paneli (rapor §3.3) ---------------------------------------------
  //
  // Panel ILK KATKIDAN ONCE yapilandirilmalidir; sonrasinda dondurulur.
  // Varsayilan 8: cok SNP'li yolun gercek agda calistigini gosterecek kadar
  // buyuk, tek islemde rahat sigacak kadar kucuk (olculen HCU tavani 12).
  const snpCount = Number(pick("SNP_COUNT", "8"));
  const rareSnpIndex = Number(process.env.RARE_SNP_INDEX ?? 0);

  // Panel OZETI — istemcinin hangi varyant listesine hizalandiginin kaniti.
  //
  // Zincir yalnizca sirali dozajlar gorur; hangi varyanta karsilik geldikleri
  // yazili degildir. Iki kullanici farkli listeler kullanirsa "3 numarali SNP"
  // farkli varyantlar olur ve tablo alakasiz seyleri toplar. Ozet bunu
  // dogrulanabilir kilar.
  //
  // Panelin kendisi zincire yazilmaz (binlerce satir); IPFS'te durur.
  const panelHash = pick("PANEL_HASH", ethers.ZeroHash);
  const panelUri = pick("PANEL_URI");

  if (panelHash === ethers.ZeroHash) {
    console.log(
      "  UYARI: PANEL_HASH verilmedi. Tek kullanicili duman testi icin sorun\n" +
        "         degil, ama GERCEK katilimcilarla panel ozeti ZORUNLUDUR —\n" +
        "         yoksa farkli dosyalar sessizce hizasiz toplanir.",
    );
  }

  // --- Veri kategorisi 2: surekli biyobelirtec modulu -----------------------
  //
  // SIRA ONEMLI: modul ILK KAYITTAN ONCE baglanmalidir. Katilimcinin sifreli
  // grup etiketinin kullanim izni kayit aninda verilir; sonradan baglanan bir
  // modul, once kaydolmus katilimcilarin etiketini kullanamaz ve o kisiler
  // hicbir zaman olcum gonderemezdi.
  const BiomarkerLib = await ethers.getContractFactory("BiomarkerStats");
  const biomarkerLib = await BiomarkerLib.deploy();
  await biomarkerLib.waitForDeployment();
  const biomarkerLibAddress = await biomarkerLib.getAddress();
  console.log(`BiomarkerStats (kutuphane): ${biomarkerLibAddress}`);

  const Biomarkers = await ethers.getContractFactory("VeriarfyBiomarkers", {
    libraries: { BiomarkerStats: biomarkerLibAddress },
  });
  const biomarkers = await Biomarkers.deploy(protocolAddress);
  await biomarkers.waitForDeployment();
  const biomarkersAddress = await biomarkers.getAddress();
  console.log(`VeriarfyBiomarkers: ${biomarkersAddress}`);

  await (await protocol.setBiomarkerModule(biomarkersAddress)).wait();
  console.log("  biyobelirtec modulu baglandi (kayitlardan ONCE)");

  await (
    await protocol.configurePanel(snpCount, rareSnpIndex, panelHash, panelUri)
  ).wait();
  console.log(`  SNP paneli: ${snpCount} varyant (nadirlik varyanti #${rareSnpIndex})`);

  // Metrik paneli: tanimi `METRICS_FILE` ile verilir (JSON dizisi). Verilmezse
  // calisma yalnizca genomiktir ve metrik kanali bos kalir.
  const metricsFile = pick("METRICS_FILE");
  if (metricsFile) {
    const specs = JSON.parse(readFileSync(metricsFile, "utf8"));
    const metricsHash = pick("METRICS_HASH", ethers.ZeroHash);
    const metricsUri = pick("METRICS_URI");

    if (metricsHash === ethers.ZeroHash) {
      console.log(
        "  UYARI: METRICS_HASH verilmedi. Aralik sinirlari zincirde zorlanir\n" +
          "         ama OLCUM PROTOKOLU (hangi test, hangi kosulda) yazili\n" +
          "         kalmaz — farkli protokolle olculen sayilar sessizce\n" +
          "         karsilastirilir.",
      );
    }

    await (
      await biomarkers.configureMetrics(specs, metricsHash, metricsUri)
    ).wait();
    console.log(`  metrik paneli: ${specs.length} metrik`);
  } else {
    console.log("  metrik paneli: yok (METRICS_FILE verilmedi — yalnizca genomik calisma)");
  }

  // Sorgu kapisi: acilim talebini yalnizca odeme sozlesmesi acabilir.
  // Rapor §2.5.2'deki "Gateway" rolu — arastirmacinin yetkisini dogrulayan ve
  // talebi ileten bilesen. Bu satir olmadan hicbir sorgu acilamaz.
  await (await protocol.setQueryGateway(paymentsAddress)).wait();
  console.log("  sorgu kapisi baglandi (protocol -> payments)");

  // --- Kripto-ekonomik guvenlik (rapor §2.7) -------------------------------
  //
  // Taban teminat raporda 32 ETH'dir; test aglarinda bu tutari edinmek mumkun
  // olmadigi icin ortam degiskeniyle kucultulebilir. Esik degeri raporun 1M USD
  // kontrol noktasindan turetilmistir (bkz. VeriarfyStaking dokumantasyonu).
  const baseStake = BigInt(process.env.NODE_BASE_STAKE ?? ethers.parseEther("0.001"));
  const valueThreshold = BigInt(process.env.STAKE_VALUE_THRESHOLD ?? 250_000);
  const challengePeriod = BigInt(process.env.CHALLENGE_PERIOD_BLOCKS ?? 20);

  const Staking = await ethers.getContractFactory("VeriarfyStaking");
  const staking = await Staking.deploy(
    deployer.address,
    protocolAddress,
    baseStake,
    valueThreshold,
  );
  await staking.waitForDeployment();
  const stakingAddress = await staking.getAddress();
  console.log(
    `VeriarfyStaking: ${stakingAddress} ` +
      `(taban teminat ${ethers.formatEther(baseStake)} ETH, esik ${valueThreshold})`,
  );

  // Ucret hacmi (TotalDataValue) odeme sozlesmesinden okunur.
  await (await staking.setPayments(paymentsAddress)).wait();
  // Modul bagli degilse teminat aranmaz; bu satir olmadan §2.7 devre disidir.
  await (await protocol.setStakingModule(stakingAddress)).wait();
  await (await protocol.setChallengePeriod(challengePeriod)).wait();
  console.log(`  guvenlik modulu baglandi (itiraz suresi ${challengePeriod} blok)`);

  // --- Dead Man's Switch (rapor §2.6.1) ------------------------------------
  //
  // Sessizlik esigi UZUN olmalidir: kisa bir esik, gecici bir altyapi
  // kesintisini "ele gecirildi" sanip yetkiyi gereksiz yere devrederdi.
  // Varsayilan ~1 gun (12 sn blok varsayimiyla).
  //
  // Varis dugumler ELLE atanir; kurumsal bir karardir ve dagitim betiginin
  // uyduracagi bir sey degildir. Atanmadigi surece devir mekanizmasi
  // sessizce devre disidir — yetkiyi bos bir kumeye devretmek havuzu kalici
  // olarak kilitlerdi.
  const livenessTimeout = BigInt(process.env.LIVENESS_TIMEOUT_BLOCKS ?? 7_200);
  await (await protocol.setLivenessTimeout(livenessTimeout)).wait();
  console.log(
    `  Dead Man's Switch: sessizlik esigi ${livenessTimeout} blok ` +
      `(varis dugum atanmadi — devir su an devre disi)`,
  );

  // --- Filecoin kalicilik defteri (rapor §2.9.2, WBS 2.3) ------------------
  //
  // Genesis zaman damgasi hangi Filecoin agina baglandigimizi belirler.
  // Her iki deger de `Filecoin.ChainGetGenesis` ile GERCEK aglardan
  // dogrulanmistir (tahmin degildir):
  //
  //   ana ag      1.598.306.400  (24 Agustos 2020, 22:00 UTC)
  //   Calibration 1.667.326.380  (1 Kasim 2022, 18:13 UTC)
  //
  // Calibration kullanilacaksa BIRLIKTE degistirilmesi gerekenler:
  //   FILECOIN_GENESIS=1667326380
  //   FILECOIN_RPC_URL=https://api.calibration.node.glif.io/rpc/v1
  //
  // Yanlis deger epoch hesabini kaydirir; `verify-storage-deals.ts` bunu
  // gercek zincir basiyla karsilastirip yakalar (20 epoch tolerans).
  const FILECOIN_MAINNET_GENESIS = 1_598_306_400;
  const filecoinGenesis = BigInt(process.env.FILECOIN_GENESIS ?? FILECOIN_MAINNET_GENESIS);

  const Storage = await ethers.getContractFactory("VeriarfyStorage");
  const storage = await Storage.deploy(deployer.address, filecoinGenesis);
  await storage.waitForDeployment();
  const storageAddress = await storage.getAddress();
  console.log(`VeriarfyStorage: ${storageAddress} (Filecoin genesis ${filecoinGenesis})`);

  // Tanik: anlasmalari kaydeden zincir disi ajan. Ayri bir adres verilmezse
  // dagitici ustlenir; uretimde kurator servisinin adresi olmalidir.
  const attestor = process.env.STORAGE_ATTESTOR ?? deployer.address;
  await (await storage.setAttestor(attestor)).wait();
  console.log(`  tanik: ${attestor}`);

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    contracts: {
      Groth16Verifier: verifierAddress,
      DataProvenanceVerifier: provenanceVerifierAddress,
      VeriarfyProtocol: protocolAddress,
      VeriarfyPayments: paymentsAddress,
      VeriarfyBiomarkers: biomarkersAddress,
      VeriarfyStaking: stakingAddress,
      VeriarfyStorage: storageAddress,
      PaymentToken: paymentTokenAddress,
      VeriArfyRegistry: registryAddress,
      AnxietyStudy: studyAddress,
    },
    paymentTokenIsTestToken: deployedTestToken,
    liquidityShareBps,
    initialRoot: initialRoot.toString(),
    accreditedRoot: institutionRegistry.root.toString(),
    deployedAt: new Date().toISOString(),
    // Olay taramalarinin baslangic noktasi: sozlesmeler bu bloktan once yoktu,
    // daha geriye bakmak genel RPC'lerin blok araligi sinirini bosuna zorlar.
    deployedAtBlock: await ethers.provider.getBlockNumber(),
  };

  const outDir = join(__dirname, "..", "deployments");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, `${network.name}.json`),
    `${JSON.stringify(out, null, 2)}\n`,
  );
  console.log(`\nAdresler yazildi: deployments/${network.name}.json`);

  // Web arayuzu dogrudan okuyabilsin.
  const webConfig = join(__dirname, "..", "..", "web", "src", "config");
  mkdirSync(webConfig, { recursive: true });
  writeFileSync(
    join(webConfig, "deployment.json"),
    `${JSON.stringify(out, null, 2)}\n`,
  );
  console.log("Web config guncellendi.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
