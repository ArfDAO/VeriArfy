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

  const Protocol = await ethers.getContractFactory("VeriarfyProtocol");
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

  // Sorgu kapisi: acilim talebini yalnizca odeme sozlesmesi acabilir.
  // Rapor §2.5.2'deki "Gateway" rolu — arastirmacinin yetkisini dogrulayan ve
  // talebi ileten bilesen. Bu satir olmadan hicbir sorgu acilamaz.
  await (await protocol.setQueryGateway(paymentsAddress)).wait();
  console.log("  sorgu kapisi baglandi (protocol -> payments)");

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    contracts: {
      Groth16Verifier: verifierAddress,
      DataProvenanceVerifier: provenanceVerifierAddress,
      VeriarfyProtocol: protocolAddress,
      VeriarfyPayments: paymentsAddress,
      PaymentToken: paymentTokenAddress,
      VeriArfyRegistry: registryAddress,
      AnxietyStudy: studyAddress,
    },
    paymentTokenIsTestToken: deployedTestToken,
    liquidityShareBps,
    initialRoot: initialRoot.toString(),
    accreditedRoot: institutionRegistry.root.toString(),
    deployedAt: new Date().toISOString(),
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
