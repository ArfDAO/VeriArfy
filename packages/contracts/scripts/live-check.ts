import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ethers, fhevm, network } from "hardhat";
import { getAddress } from "ethers";

import { parseAuthorizedNodeAddresses } from "./node-addresses";
import {
  approvalStageDecision,
  assertApprovalStageResult,
  assertCompleteApprovalState,
  parseLiveCheckId,
  parseLiveCheckQueryType,
  parseLiveCheckStage,
  type LiveCheckQueryType,
  type LiveCheckStage,
} from "./live-check-state";
import {
  D15_PROFILE_ID,
  loadD15Profile,
  sameAddress as sameProfileAddress,
} from "./d15-profile";

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

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function deploymentNodeAddresses(record: any): string[] {
  if (!Array.isArray(record.authorizedNodes)) {
    throw new Error(
      "deployment JSON authorizedNodes icermiyor; live-check public node topolojisini env'den turetemez",
    );
  }
  return parseAuthorizedNodeAddresses(record.authorizedNodes.join(","));
}

function requireSingleSigner<T extends { address: string }>(signers: readonly T[]): T {
  if (signers.length !== 1) {
    throw new Error(
      `live-check signer isolation ihlali: beklenen 1 signer, bulunan ${signers.length}`,
    );
  }
  return signers[0];
}

function configuredDeployer(record: any): string {
  if (typeof record.deployer !== "string") {
    throw new Error("deployment JSON deployer adresi eksik");
  }
  try {
    return getAddress(record.deployer);
  } catch {
    throw new Error("deployment JSON deployer adresi gecersiz");
  }
}

async function assertPrepareTopology(
  protocol: any,
  record: any,
  authorizedNodes: string[],
  queryType: LiveCheckQueryType,
  signerAddress: string,
): Promise<void> {
  if (authorizedNodes.length < 2 || sameAddress(authorizedNodes[0], authorizedNodes[1])) {
    throw new Error("prepare: deployment authorizedNodes en az iki distinct dugum icermeli");
  }
  if (await protocol.isFailoverActive()) {
    throw new Error("prepare: failover active; main node akisi baslatilamaz");
  }

  const required = BigInt(await protocol.requiredApprovals(queryType));
  if (required !== 2n) {
    throw new Error(
      `prepare: LIVE_CHECK_QUERY_TYPE=${queryType} icin requiredApprovals=${required}; 2 olmali`,
    );
  }

  const stakingAddress = record.contracts?.VeriarfyStaking;
  if (typeof stakingAddress !== "string" || !ethers.isAddress(stakingAddress)) {
    throw new Error("prepare: deployment JSON VeriarfyStaking adresi eksik/gecersiz");
  }
  const configuredStaking = getAddress(stakingAddress);
  const onChainStaking = getAddress(await protocol.stakingModule());
  if (onChainStaking === ethers.ZeroAddress || onChainStaking !== configuredStaking) {
    throw new Error("prepare: staking module deployment ile eslesmiyor veya yok");
  }

  const staking = await ethers.getContractAt("VeriarfyStaking", configuredStaking);
  const [participantCount, minParticipants, alreadyParticipant] = await Promise.all([
    protocol.participantCount(),
    protocol.minParticipants(),
    protocol.hasAggregated(signerAddress),
  ]);
  const projectedParticipants = BigInt(participantCount) + (alreadyParticipant ? 0n : 1n);
  if (projectedParticipants < BigInt(minParticipants)) {
    throw new Error(
      `prepare: k-anonimlik esigi saglanamaz (mevcut=${participantCount}, ` +
        `beklenen en az=${minParticipants}, bu kosum sonrasi=${projectedParticipants})`,
    );
  }

  const requiredStake = BigInt(await staking.minStake());
  for (const node of authorizedNodes.slice(0, 2)) {
    if (!(await protocol.isAuthorizedNode(node))) {
      throw new Error(`prepare: node zincirde yetkili degil: ${node}`);
    }
    const stake = BigInt(await staking.stakeOf(node));
    if (stake < requiredStake) {
      throw new Error(`prepare: node stake yetersiz: ${node}`);
    }
    if (!(await staking.canApprove(node))) {
      throw new Error(`prepare: node canApprove=false: ${node}`);
    }
  }
}

async function runApprovalStage(
  stage: "node-1" | "node-2",
  requestId: bigint,
  queryId: bigint,
  record: any,
  authorizedNodes: string[],
  signer: any,
): Promise<void> {
  const protocolAddress = record.contracts?.VeriarfyProtocol;
  if (typeof protocolAddress !== "string" || !ethers.isAddress(protocolAddress)) {
    throw new Error(`${stage}: deployment JSON VeriarfyProtocol adresi eksik/gecersiz`);
  }
  const protocol = await ethers.getContractAt("VeriarfyProtocol", protocolAddress);
  const paymentsAddress = record.contracts?.VeriarfyPayments;
  if (typeof paymentsAddress !== "string" || !ethers.isAddress(paymentsAddress)) {
    throw new Error(`${stage}: deployment JSON VeriarfyPayments adresi eksik/gecersiz`);
  }
  const payments = await ethers.getContractAt("VeriarfyPayments", paymentsAddress);
  const query = await payments.query(queryId);
  if (BigInt(query.disclosureRequestId) !== requestId) {
    throw new Error(`${stage}: queryId/requestId handoff eslesmiyor`);
  }
  const expectedIndex = stage === "node-1" ? 0 : 1;
  const expectedSigner = authorizedNodes[expectedIndex];

  if (!sameAddress(signer.address, expectedSigner)) {
    throw new Error(
      `${stage}: signer configured authorizedNodes[${expectedIndex}] ile eslesmiyor`,
    );
  }

  const [requester, snapshotCount, requestedAt, finalized, approvals] =
    await protocol.disclosureRequest(requestId);
  void snapshotCount;
  void requestedAt;
  if (requester === ethers.ZeroAddress) throw new Error(`${stage}: disclosure request yok`);
  if (!sameAddress(query.researcher, requester)) {
    throw new Error(`${stage}: query researcher disclosure requester ile eslesmiyor`);
  }
  const requestRequired = BigInt(await protocol.disclosureRequiredApprovals(requestId));
  if (requestRequired !== 2n) {
    throw new Error(`${stage}: disclosure requiredApprovals=${requestRequired}; 2 olmali`);
  }

  const node1Approved = await protocol.hasApproved(requestId, authorizedNodes[0]);
  const node2Approved = await protocol.hasApproved(requestId, authorizedNodes[1]);
  const ownApproved = stage === "node-1" ? node1Approved : node2Approved;

  // A count without the expected configured-node approvals is a foreign
  // approver or an invalid operator handoff; never treat it as idempotent.
  if (BigInt(approvals) === 2n && Boolean(finalized)) {
    if (!node1Approved || !node2Approved) {
      throw new Error(`${stage}: finalized durumunda beklenen iki node approval yok`);
    }
  } else if (
    stage === "node-1" &&
    BigInt(approvals) === 1n &&
    !Boolean(finalized) &&
    !node1Approved
  ) {
    throw new Error("node-1: mevcut ilk approval foreign signer tarafindan verilmis");
  } else if (
    stage === "node-2" &&
    BigInt(approvals) === 1n &&
    !Boolean(finalized) &&
    !node1Approved
  ) {
    throw new Error("node-2: node-1 approval foreign signer tarafindan verilmis");
  }

  const decision = approvalStageDecision(stage, BigInt(approvals), Boolean(finalized));
  if (decision === "already-complete") {
    console.log(
      `${stage}: approval state zaten dogru (approvals=${approvals}, finalized=${finalized})`,
    );
    return;
  }
  if (ownApproved) {
    throw new Error(`${stage}: signer approval var ancak zincir state beklenmedik`);
  }

  // Buradan sonrasi yeni bir transaction gonderebilir. Terminal/idempotent
  // durumlar yukarida salt-okunur kanitla dondu; guncel yetki, stake ve
  // failover kontrolleri yalniz yeni approval icin zorunludur.
  if (query.refunded) throw new Error(`${stage}: query iade edilmis`);
  if (query.settled) throw new Error(`${stage}: query zaten settled`);
  if (await protocol.isDisclosureGranted(requestId)) {
    throw new Error(`${stage}: disclosure zaten execute edilmis`);
  }
  if (await protocol.isDisclosureRevoked(requestId)) {
    throw new Error(`${stage}: disclosure revoke edilmis`);
  }
  if (await protocol.isFailoverActive()) {
    throw new Error(`${stage}: failover active; main node approval durduruldu`);
  }
  if (!(await protocol.isAuthorizedNode(signer.address))) {
    throw new Error(`${stage}: signer zincirde yetkili degil`);
  }

  const stakingAddress = record.contracts?.VeriarfyStaking;
  if (typeof stakingAddress !== "string" || !ethers.isAddress(stakingAddress)) {
    throw new Error(`${stage}: staking module deployment adresi eksik/gecersiz`);
  }
  const onChainStaking = getAddress(await protocol.stakingModule());
  const configuredStaking = getAddress(stakingAddress);
  if (onChainStaking === ethers.ZeroAddress || onChainStaking !== configuredStaking) {
    throw new Error(`${stage}: staking module yok veya deployment ile eslesmiyor`);
  }
  const staking = await ethers.getContractAt("VeriarfyStaking", configuredStaking);
  const requiredStake = BigInt(await staking.minStake());
  const signerStake = BigInt(await staking.stakeOf(signer.address));
  if (signerStake < requiredStake || !(await staking.canApprove(signer.address))) {
    throw new Error(`${stage}: signer stake/canApprove preflight basarisiz`);
  }

  // getContractAt tek configured signer'a baglidir; requireSingleSigner ve
  // expected-address kontrolleri yukarida bu runner'i fail-closed sabitler.
  const tx = await protocol.approveDisclosure(requestId);
  const receipt = await tx.wait();
  console.log(`${stage} approveDisclosure tx: ${tx.hash} (gas ${receipt?.gasUsed})`);

  const [, , , afterFinalized, afterApprovals] = await protocol.disclosureRequest(requestId);
  assertApprovalStageResult(stage, BigInt(afterApprovals), Boolean(afterFinalized));
  console.log(`${stage}: approval state approvals=${afterApprovals}, finalized=${afterFinalized}`);
}

/**
 * Sentetik panel — koken kaniti icin. Gercek hasta verisi DEGILDIR.
 *
 * Uzunluk devrenin `PANEL_SIZE`'indan gelir; sabit yazilmaz. Panel
 * buyutuldugunde bu betik sessizce eski boyutta kalirsa kanit uretimi
 * "uzunluk uyusmuyor" ile duser ve canli dogrulama bosa gider.
 */
let PANEL: number[] = [];

async function runComplete(
  queryId: bigint,
  requestId: bigint | null,
  record: any,
  authorizedNodes: string[],
  signer: any,
): Promise<void> {
  if (!sameAddress(signer.address, configuredDeployer(record))) {
    throw new Error("complete: signer deployment deployer adresi ile eslesmiyor");
  }
  if (requestId === null) throw new Error("complete: LIVE_CHECK_REQUEST_ID eksik");

  const protocolAddress = record.contracts?.VeriarfyProtocol;
  const paymentsAddress = record.contracts?.VeriarfyPayments;
  const tokenAddress = record.contracts?.PaymentToken;
  if (
    typeof protocolAddress !== "string" ||
    typeof paymentsAddress !== "string" ||
    typeof tokenAddress !== "string" ||
    !ethers.isAddress(protocolAddress) ||
    !ethers.isAddress(paymentsAddress) ||
    !ethers.isAddress(tokenAddress)
  ) {
    throw new Error("complete: deployment JSON payment/protocol adresleri eksik/gecersiz");
  }

  const protocol = await ethers.getContractAt("VeriarfyProtocol", protocolAddress);
  const payments = await ethers.getContractAt("VeriarfyPayments", paymentsAddress);
  const token = await ethers.getContractAt("StableTestToken", tokenAddress);
  let q: any = await payments.query(queryId);

  if (!sameAddress(q.researcher, signer.address)) {
    throw new Error("complete: query researcher signer ile eslesmiyor");
  }
  if (BigInt(q.disclosureRequestId) !== requestId) {
    throw new Error("complete: query/request id handoff eslesmiyor");
  }
  if (q.refunded) throw new Error("complete: query iade edilmis");

  const [, , , finalized, approvals] = await protocol.disclosureRequest(requestId);
  const requestRequired = BigInt(await protocol.disclosureRequiredApprovals(requestId));
  const [node1Approved, node2Approved] = await Promise.all([
    protocol.hasApproved(requestId, authorizedNodes[0]),
    protocol.hasApproved(requestId, authorizedNodes[1]),
  ]);
  assertCompleteApprovalState(
    requestRequired,
    BigInt(approvals),
    Boolean(finalized),
    Boolean(node1Approved),
    Boolean(node2Approved),
  );
  if (await protocol.isDisclosureRevoked(requestId)) {
    throw new Error("complete: disclosure revoke edilmis");
  }

  if (!(await protocol.isDisclosureGranted(requestId))) {
    const windowEnd = BigInt(await protocol.challengeWindowEnd(requestId));
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
    while (current < windowEnd) {
      console.log(`complete: challenge window acik (blok ${current} -> ${windowEnd})`);
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      current = await readBlock();
    }

    const executeTx = await protocol.executeDisclosure(requestId);
    const executeReceipt = await executeTx.wait();
    console.log(`executeDisclosure tx: ${executeTx.hash} (gas ${executeReceipt?.gasUsed})`);
  }
  if (!(await protocol.isDisclosureGranted(requestId))) {
    throw new Error("complete: disclosure execute edilmedi");
  }

  if (q.settled) {
    console.log("complete: query zaten settled");
  } else {
    const settleTx = await payments.settleQuery(queryId);
    const settleReceipt = await settleTx.wait();
    console.log(`settleQuery tx: ${settleTx.hash} (gas ${settleReceipt?.gasUsed})`);
  }
  q = await payments.query(queryId);

  const rawWeight = await payments.coverageWeight(queryId, signer.address);
  const weighted = await payments.weightedCoverage(queryId, signer.address);
  const weightedAll = await payments.weightedTotal(queryId);
  console.log(`odeme kapsama ${rawWeight} alan; agirlik ${weighted}/${weightedAll}`);

  if (await payments.hasClaimed(queryId, signer.address)) {
    console.log("complete: pay zaten claim edilmis");
  } else {
    const share = await payments.claimable(queryId, signer.address);
    if (share === 0n) throw new Error("complete: claimable pay sifir");
    const balanceBefore = await token.balanceOf(signer.address);
    const claimTx = await payments.claim(queryId);
    const claimReceipt = await claimTx.wait();
    const gained = (await token.balanceOf(signer.address)) - balanceBefore;
    console.log(`claim tx: ${claimTx.hash} (gas ${claimReceipt?.gasUsed})`);
    if (gained !== share) throw new Error(`complete: claim tutari farkli: ${gained} != ${share}`);
  }

  console.log("--- Gizlilik Paneli okumasi ---");
  const [pendingTotal, pendingIds] = await payments.pendingRewards(signer.address);
  const panelFields = {
    cid: await protocol.userCIDs(signer.address),
    participantIndex: await protocol.participantIndex(signer.address),
    participantCount: await protocol.participantCount(),
    minParticipants: await protocol.minParticipants(),
    inPool: (await protocol.leftPoolAtBlock(signer.address)) === 0n,
    pendingRewards: pendingTotal.toString(),
    pendingQueries: pendingIds.length,
    tokenBalance: (await token.balanceOf(signer.address)).toString(),
    tokenSymbol: await token.symbol(),
  };
  for (const [key, value] of Object.entries(panelFields)) console.log(`  ${key}: ${value}`);
  if (panelFields.cid === ethers.ZeroHash) throw new Error("complete: panel CID okuyamadi");
  if (!panelFields.inPool) throw new Error("complete: katilimci havuzdan cikmis gorunuyor");
  console.log("Canli dogrulama complete asamasi tamamlandi.");
}

async function main() {
  const stage: LiveCheckStage = parseLiveCheckStage(process.env.LIVE_CHECK_STAGE);
  const d15Profile =
    process.env.D15_PROFILE === D15_PROFILE_ID ? loadD15Profile() : null;
  if (process.env.D15_PROFILE && !d15Profile) {
    throw new Error(`bilinmeyen D15_PROFILE: ${process.env.D15_PROFILE}`);
  }
  if (network.name === "hardhat") {
    throw new Error(
      "Bu betik gercek agda anlamlidir; mock ag icin `npx hardhat test` kullanin.",
    );
  }

  const record = JSON.parse(
    readFileSync(join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"),
  );
  const authorizedNodes = deploymentNodeAddresses(record);
  if (d15Profile) {
    if (
      !sameProfileAddress(configuredDeployer(record), d15Profile.deployer) ||
      authorizedNodes.length !== 2 ||
      !sameProfileAddress(authorizedNodes[0], d15Profile.authorizedNodes[0]) ||
      !sameProfileAddress(authorizedNodes[1], d15Profile.authorizedNodes[1])
    ) {
      throw new Error("deployment JSON D15 public profile ile eslesmiyor");
    }
  }
  const handoffRequestId =
    stage === "node-1" || stage === "node-2" || stage === "complete"
      ? parseLiveCheckId(process.env.LIVE_CHECK_REQUEST_ID, "LIVE_CHECK_REQUEST_ID")
      : null;
  const handoffQueryId =
    stage === "node-1" || stage === "node-2" || stage === "complete"
      ? parseLiveCheckId(process.env.LIVE_CHECK_QUERY_ID, "LIVE_CHECK_QUERY_ID")
      : null;
  const queryType =
    stage === "prepare" ? parseLiveCheckQueryType(process.env.LIVE_CHECK_QUERY_TYPE) : null;
  if (d15Profile && stage === "prepare" && queryType !== d15Profile.queryType) {
    throw new Error(`prepare query type ${d15Profile.queryType} olmali`);
  }

  const address: string = record.contracts?.VeriarfyProtocol;
  if (typeof address !== "string" || !ethers.isAddress(address)) {
    throw new Error("deployment JSON VeriarfyProtocol adresi eksik/gecersiz");
  }

  if (stage === "node-1" || stage === "node-2") {
    const signer = requireSingleSigner(await ethers.getSigners());
    await runApprovalStage(
      stage,
      handoffRequestId as bigint,
      handoffQueryId as bigint,
      record,
      authorizedNodes,
      signer,
    );
    return;
  }

  if (stage === "complete") {
    const signer = requireSingleSigner(await ethers.getSigners());
    await runComplete(
      handoffQueryId as bigint,
      handoffRequestId,
      record,
      authorizedNodes,
      signer,
    );
    return;
  }

  const signer = requireSingleSigner(await ethers.getSigners());
  if (!sameAddress(signer.address, configuredDeployer(record))) {
    throw new Error("prepare: signer deployment deployer adresi ile eslesmiyor");
  }
  const protocol = await ethers.getContractAt("VeriarfyProtocol", address);

  // This is deliberately before relayer initialization, proof generation, or
  // the first transaction.  It checks the deployed topology instead of
  // trusting a second environment variable to describe it.
  await assertPrepareTopology(
    protocol,
    record,
    authorizedNodes,
    queryType as LiveCheckQueryType,
    signer.address,
  );

  // Gercek agda relayer/KMS istemcisi tembel kurulur; bu cagri olmadan
  // `createEncryptedInput` "plugin is not initialized" ile duser.
  await fhevm.initializeCLIApi();

  console.log(`Asama    : ${stage}`);
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

  // KATMAN SECIMI — bilerek IMZASIZ.
  //
  // Bu betik, sitenin gercekten kullandigi yolu olcmelidir. Akredite kurum
  // entegrasyonumuz yok; kullanici kendi tuketici dosyasini yukluyor ve o
  // dosyanin kurumsal imzasi YOKTUR. Imzali yolu olcmek, uretimde
  // calismayan bir seyi dogrulamak olurdu.
  //
  // Kok yine de karsilastirilir ama HATA DEGIL BILGIDIR: imzali katman
  // ileride devreye girdiginde uyusmazlik burada gorulsun.
  const onChainRoot = await protocol.accreditedRoot();
  if (onChainRoot !== institutionRegistry.root) {
    console.log(
      `  not: akredite kok farkli (zincir ${onChainRoot}) — imzasiz katmanda kullanilmiyor`,
    );
  }

  const salt = provenance.randomSalt();
  const commitment = provenance.panelCommitment(PANEL, salt);

  const circuitsDir = join(__dirname, "..", "..", "circuits");
  const provenanceInput = provenance.buildSelfProvenanceInput({
    dosages: PANEL,
    salt,
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
      false, // imzasiz katman: kullanicinin kendi yukledigi veri
      0n, // devre koku zorla sifirlar; sozlesme de sifir bekler
      provenance.computeProvenanceNullifier(await protocol.PROVENANCE_SCOPE(), commitment),
      commitment,
      // KAPSAMA — devrenin acik ciktisi. Odeme buna gore dagitilir; istemciden
      // gelseydi uydurulabilirdi.
      provenance.coverageWords(PANEL),
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
        // Kapsama maskesi: bu duman testinde her SNP'ye gercek deger
        // gonderiliyor, dolayisiyla hepsi kapsandi.
        .contributeDosages(encrypted.handles, (1n << BigInt(size)) - 1n, encrypted.inputProof);
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
          // Duman testinde her metrige gecerli deger gonderiliyor.
          .contributeBiomarkers(encrypted.handles, (1n << BigInt(size)) - 1n, encrypted.inputProof);
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
  if (isCarrier) {
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

  // IZIN ADIMI KALKTI: havuza yuklemek zaten izindir (bkz. `leavePool`).
  // Arastirmaci bazinda izin, mimarinin tutamayacagi bir sozdu — acilim
  // TOPLAMI cozer ve toplam tektir.
  // FIYAT ARTIK KAYIT BASINA (MK-0018): carpan havuz buyuklugu degil,
  // istenen alanlarda GERCEKTEN verisi olan kisi sayisi. Kayit = kisi x alan.
  const [fee, records] = await payments.quote();
  const pool = await protocol.participantCount();
  console.log(
    `Sorgu ucreti: ${fee}  (${records} kayit = kisi x alan; havuzda ${pool} katilimci)`,
  );

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

  // Query type was validated before the first mutation; this second read is
  // included in the handoff evidence emitted below.
  const needed = BigInt(await protocol.requiredApprovals(queryType as LiveCheckQueryType));
  if (needed !== 2n) {
    throw new Error(
      `prepare: openQuery oncesi requiredApprovals=${needed}; 2 olmali`,
    );
  }
  console.log(`BSKK-44 esigi: ${needed} onay (sorgu tipi: ${queryType})`);

  const openTx = await payments.openQuery(queryType as LiveCheckQueryType);
  const openReceipt = await openTx.wait();
  const queryId = (await payments.nextQueryId()) - 1n;
  console.log(`openQuery tx: ${openTx.hash}  (gas ${openReceipt?.gasUsed})`);

  const q = await payments.query(queryId);
  console.log(`  ucret ${q.fee} EMANETTE (acilim talebi #${q.disclosureRequestId})`);

  // Ucret onay gelene kadar dagitilmaz — emanet gercekten calisiyor mu?
  if (q.settled) throw new Error("ucret onaydan once dagitildi");
  if ((await payments.claimable(queryId, signer.address)) !== 0n) {
    throw new Error("onaydan once pay hesaplandi");
  }
  console.log("  emanet dogrulandi: onay gelmeden pay hesaplanmiyor");

  console.log(`LIVE_CHECK_QUERY_ID=${queryId}`);
  console.log(`LIVE_CHECK_REQUEST_ID=${q.disclosureRequestId}`);
  return;

}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nCanli dogrulama BASARISIZ: ${err.message ?? err}`);
    process.exit(1);
  });
