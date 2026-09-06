import { join } from "node:path";

import { getBytes, getCreateAddress, keccak256, ZeroAddress } from "ethers";
import { artifacts, ethers, network } from "hardhat";

import { D15_PROFILE_ID, loadD15Profile, sameAddress } from "./d15-profile";
import {
  assertD15ResumeBaselineState,
  assertResumeBoundaryNonce,
  assertResumeNonce,
  d15ResumeBoundaryState,
  loadD15ResumeManifest,
  type D15ResumeManifest,
} from "./d15-resume-state";
import { loadStudyConfig } from "./study-config";
import { assertBytecodeHash, bytecodeHash, patchedRuntimeHash } from "./d15-artifacts";
import { publishD15OutputPair } from "./d15-output";

type AnyContract = any;
type Tx = {
  nonce: number;
  wait: (...args: any[]) => Promise<{ status?: number | bigint | null } | null>;
};
type ArtifactChecks = {
  stakingOutput: any;
  storageOutput: any;
};

function readBuildOutput(artifact: any, buildInfo: any, expectedTemplateHash: string, label: string): any {
  const output = buildInfo?.output?.contracts?.[artifact.sourceName]?.[artifact.contractName]?.evm?.deployedBytecode;
  if (typeof output?.object !== "string" || !output.object || !output.immutableReferences) {
    throw new Error(`${label} build-info immutableReferences eksik`);
  }
  const immutableIds = Object.keys(output.immutableReferences);
  if (immutableIds.length !== 1) {
    throw new Error(`${label} build-info tam bir immutable kimligi icermeli`);
  }
  const bytecode = output.object.startsWith("0x") ? output.object : `0x${output.object}`;
  assertBytecodeHash(bytecode, expectedTemplateHash, `${label} build-info template`);
  return output;
}

async function readArtifactChecks(manifest: D15ResumeManifest): Promise<ArtifactChecks> {
  const staking = await artifacts.readArtifact("VeriarfyStaking");
  const storage = await artifacts.readArtifact("VeriarfyStorage");
  assertBytecodeHash(staking.bytecode, manifest.resume.stakingCreationHash, "VeriarfyStaking creation artifact");
  assertBytecodeHash(
    staking.deployedBytecode,
    manifest.resume.stakingTemplateHash,
    "VeriarfyStaking deployed template artifact",
  );
  assertBytecodeHash(storage.bytecode, manifest.resume.storageCreationHash, "VeriarfyStorage creation artifact");
  assertBytecodeHash(
    storage.deployedBytecode,
    manifest.resume.storageTemplateHash,
    "VeriarfyStorage deployed template artifact",
  );
  const stakingBuildInfo = await artifacts.getBuildInfo(`${staking.sourceName}:${staking.contractName}`);
  const storageBuildInfo = await artifacts.getBuildInfo(`${storage.sourceName}:${storage.contractName}`);
  if (!stakingBuildInfo || !storageBuildInfo) throw new Error("D15 resume build-info eksik");
  const stakingOutput = readBuildOutput(
    staking,
    stakingBuildInfo,
    manifest.resume.stakingTemplateHash,
    "VeriarfyStaking",
  );
  const storageOutput = readBuildOutput(
    storage,
    storageBuildInfo,
    manifest.resume.storageTemplateHash,
    "VeriarfyStorage",
  );
  return { stakingOutput, storageOutput };
}

async function assertLiveRuntime(
  address: string,
  output: any,
  immutableValue: string | bigint,
  label: string,
): Promise<void> {
  const immutableIds = Object.keys(output.immutableReferences);
  const expected = patchedRuntimeHash(output.object, output.immutableReferences, { [immutableIds[0]]: immutableValue });
  const live = await ethers.provider.getCode(address);
  if (live === "0x" || bytecodeHash(live, `${label} live`) !== expected) {
    throw new Error(`${label} live runtime immutable patch hash eslesmiyor`);
  }
}

function mustAddress(actual: string, expected: string, label: string): void {
  if (!sameAddress(actual, expected)) throw new Error(`${label} beklenen adreste degil`);
}

function mustBigInt(actual: bigint, expected: string, label: string): void {
  if (actual !== BigInt(expected)) throw new Error(`${label} beklenen degerde degil`);
}

function mustZeroAddress(actual: string, label: string): void {
  mustAddress(actual, ZeroAddress, label);
}

async function assertContext(manifest: D15ResumeManifest, signer?: AnyContract): Promise<void> {
  const chain = await ethers.provider.getNetwork();
  if (network.name !== manifest.network || chain.chainId !== BigInt(manifest.chainId)) {
    throw new Error(`D15 resume yanlis ag: ${network.name}/${chain.chainId}`);
  }
  if (signer) mustAddress(signer.address, manifest.deployer, "resume signer");
}

async function assertCreatedContracts(manifest: D15ResumeManifest): Promise<void> {
  for (const nonce of manifest.completedNonces) {
    const item = manifest.created[String(nonce)];
    if (!item) continue;
    const derived = getCreateAddress({ from: manifest.deployer, nonce });
    mustAddress(derived, item.address, `CREATE nonce ${nonce}`);
    const code = await ethers.provider.getCode(item.address);
    if (code === "0x") throw new Error(`${item.name} ${item.address} kodsuz`);
    const actualHash = keccak256(getBytes(code)).toLowerCase();
    if (actualHash !== item.codeHash) {
      throw new Error(`${item.name} runtime code hash beklenen degerde degil`);
    }
  }
}

async function assertBoundary(
  manifest: D15ResumeManifest,
  profile: ReturnType<typeof loadD15Profile>,
  metrics: NonNullable<ReturnType<typeof loadStudyConfig>["metrics"]>,
  metricsHash: string,
  metricsSpecDigest: string,
  metricsUri: string,
  artifactsForResume: ArtifactChecks,
  boundary: number,
): Promise<void> {
  const boundaryState = d15ResumeBoundaryState(boundary);
  const latest = await ethers.provider.getTransactionCount(manifest.deployer, "latest");
  const pending = await ethers.provider.getTransactionCount(manifest.deployer, "pending");
  assertResumeNonce(latest, pending, boundary);
  await assertCreatedContracts(manifest);

  const contracts: Record<string, string> = {};
  for (const nonce of manifest.completedNonces) {
    const item = manifest.created[String(nonce)];
    if (item) contracts[item.name] = item.address;
  }
  const protocol: AnyContract = await ethers.getContractAt("VeriarfyProtocol", contracts.VeriarfyProtocol);
  const biomarkers: AnyContract = await ethers.getContractAt("VeriarfyBiomarkers", contracts.VeriarfyBiomarkers);
  const registry: AnyContract = await ethers.getContractAt("VeriArfyRegistry", contracts.VeriArfyRegistry);
  const study: AnyContract = await ethers.getContractAt("AnxietyStudy", contracts.AnxietyStudy);
  const payments: AnyContract = await ethers.getContractAt("VeriarfyPayments", contracts.VeriarfyPayments);
  const token: AnyContract = await ethers.getContractAt("StableTestToken", contracts.StableTestToken);

  const protocolState = {
    owner: await protocol.owner(),
    threshold: await protocol.disclosureThreshold(),
    minParticipants: await protocol.minParticipants(),
    authorizedNodeCount: await protocol.authorizedNodeCount(),
    authorizedNodes: await Promise.all(profile.authorizedNodes.map((node) => protocol.isAuthorizedNode(node))),
    biomarkerModule: await protocol.biomarkerModule(),
    queryGateway: await protocol.queryGateway(),
    stakingModule: await protocol.stakingModule(),
    challengePeriod: await protocol.challengePeriod(),
    livenessTimeout: await protocol.livenessTimeout(),
    snpCount: await protocol.snpCount(),
    rareSnpIndex: await protocol.rareSnpIndex(),
    panelHash: await protocol.panelHash(),
    panelUri: await protocol.panelUri(),
    accreditedRoot: await protocol.accreditedRoot(),
  };
  const biomarkerState = {
    owner: await biomarkers.owner(),
    protocol: await biomarkers.protocol(),
    metricCount: await biomarkers.metricCount(),
    metricsHash: await biomarkers.metricsHash(),
    metricsUri: await biomarkers.metricsUri(),
    panelFrozen: await biomarkers.panelFrozen(),
  };
  if (boundary === 15) {
    assertD15ResumeBaselineState(protocolState, biomarkerState, manifest);
  } else {
    mustAddress(protocolState.owner, manifest.deployer, "protocol.owner");
    mustBigInt(protocolState.threshold, "2", "protocol.threshold");
    mustBigInt(protocolState.minParticipants, "1", "protocol.minParticipants");
    mustBigInt(protocolState.authorizedNodeCount, "2", "protocol.authorizedNodeCount");
    if (protocolState.authorizedNodes.length !== 2 || protocolState.authorizedNodes.some((value: boolean) => !value)) {
      throw new Error("protocol authorized node state beklenen degerde degil");
    }
    mustAddress(protocolState.biomarkerModule, contracts.VeriarfyBiomarkers, "protocol.biomarkerModule");
    mustBigInt(protocolState.snpCount, String(manifest.resume.snpCount), "protocol.snpCount");
    mustBigInt(protocolState.rareSnpIndex, String(manifest.resume.rareSnpIndex), "protocol.rareSnpIndex");
    if (
      protocolState.panelHash.toLowerCase() !== manifest.expected.protocol.panelHash ||
      protocolState.panelUri !== manifest.expected.protocol.panelUri
    ) {
      throw new Error("protocol panel state beklenen degerde degil");
    }
    mustBigInt(protocolState.accreditedRoot, manifest.expected.protocol.accreditedRoot, "protocol.accreditedRoot");
    mustAddress(biomarkerState.owner, manifest.deployer, "biomarkers.owner");
    mustAddress(biomarkerState.protocol, contracts.VeriarfyProtocol, "biomarkers.protocol");
  }

  mustAddress(await registry.verifier(), contracts.Groth16Verifier, "registry.verifier");
  mustBigInt(await registry.currentRoot(), manifest.expected.registryRoot, "registry.currentRoot");
  mustAddress(await study.registry(), contracts.VeriArfyRegistry, "study.registry");
  mustAddress(await study.owner(), manifest.deployer, "study.owner");
  mustAddress(await protocol.provenanceVerifier(), contracts.DataProvenanceVerifier, "protocol.provenanceVerifier");
  mustAddress(await payments.owner(), manifest.deployer, "payments.owner");
  mustAddress(await payments.token(), contracts.StableTestToken, "payments.token");
  mustAddress(await payments.protocol(), contracts.VeriarfyProtocol, "payments.protocol");
  mustAddress(await payments.researchers(), contracts.VeriArfyRegistry, "payments.researchers");
  mustBigInt(await payments.liquidityShareBps(), "8000", "payments.liquidityShareBps");
  mustBigInt(await payments.baseFee(), "1000000", "payments.baseFee");
  mustBigInt(await payments.perRecordFee(), "50000", "payments.perRecordFee");
  mustAddress(await token.owner(), manifest.deployer, "token.owner");

  const expectedGateway = boundaryState.queryGatewayConfigured ? contracts.VeriarfyPayments : ZeroAddress;
  mustAddress(await protocol.queryGateway(), expectedGateway, "protocol.queryGateway");
  const expectedStakingModule = boundaryState.stakingModuleConfigured ? manifest.resume.stakingAddress : ZeroAddress;
  mustAddress(await protocol.stakingModule(), expectedStakingModule, "protocol.stakingModule");
  const expectedChallenge = boundaryState.challengeConfigured ? manifest.resume.challengePeriod : "0";
  const expectedLiveness = boundaryState.livenessConfigured ? manifest.resume.livenessTimeout : "0";
  mustBigInt(await protocol.challengePeriod(), expectedChallenge, "protocol.challengePeriod");
  mustBigInt(await protocol.livenessTimeout(), expectedLiveness, "protocol.livenessTimeout");

  if (boundaryState.metricsConfigured) {
    mustBigInt(await biomarkers.metricCount(), String(metrics.length), "biomarkers.metricCount");
    if (
      (await biomarkers.metricsHash()).toLowerCase() !== metricsHash ||
      (await biomarkers.metricsUri()) !== metricsUri
    ) {
      throw new Error("biomarkers metrics state local config ile eslesmiyor");
    }
    if (metricsSpecDigest !== manifest.resume.metricsSpecHash)
      throw new Error("metrics spec hash manifest ile eslesmiyor");
    for (let index = 0; index < metrics.length; index += 1) {
      const actual = await biomarkers.metricAt(index);
      const expected = metrics[index];
      if (
        actual.code.toLowerCase() !== expected.code ||
        actual.unit.toLowerCase() !== expected.unit ||
        BigInt(actual.scale) !== BigInt(expected.scale) ||
        BigInt(actual.offset) !== BigInt(expected.offset) ||
        BigInt(actual.minValue) !== BigInt(expected.minValue) ||
        BigInt(actual.maxValue) !== BigInt(expected.maxValue)
      )
        throw new Error(`metricAt(${index}) local JSON ile eslesmiyor`);
    }
  } else {
    mustBigInt(await biomarkers.metricCount(), "0", "biomarkers.metricCount");
    if (
      (await biomarkers.metricsHash()).toLowerCase() !== `0x${"0".repeat(64)}` ||
      (await biomarkers.metricsUri()) !== ""
    ) {
      throw new Error("biomarkers metrics baseline bos olmali");
    }
  }
  if (await biomarkers.panelFrozen()) throw new Error("biomarkers.panelFrozen false olmali");

  const stakingCode = await ethers.provider.getCode(manifest.resume.stakingAddress);
  if (!boundaryState.stakingDeployed) {
    if (stakingCode !== "0x") throw new Error("staking boundary oncesi kod barindiriyor");
  } else {
    await assertLiveRuntime(
      manifest.resume.stakingAddress,
      artifactsForResume.stakingOutput,
      contracts.VeriarfyProtocol,
      "VeriarfyStaking",
    );
    const staking = await ethers.getContractAt("VeriarfyStaking", manifest.resume.stakingAddress);
    mustAddress(await staking.owner(), manifest.deployer, "staking.owner");
    mustAddress(await staking.protocol(), contracts.VeriarfyProtocol, "staking.protocol");
    mustBigInt(await staking.baseStake(), manifest.resume.baseStakeWei, "staking.baseStake");
    mustBigInt(await staking.valueThreshold(), manifest.resume.valueThreshold, "staking.valueThreshold");
    mustAddress(
      await staking.payments(),
      boundaryState.stakingPaymentsConfigured ? contracts.VeriarfyPayments : ZeroAddress,
      "staking.payments",
    );
  }

  const storageCode = await ethers.provider.getCode(manifest.resume.storageAddress);
  if (!boundaryState.storageDeployed) {
    if (storageCode !== "0x") throw new Error("storage boundary oncesi kod barindiriyor");
  } else {
    await assertLiveRuntime(
      manifest.resume.storageAddress,
      artifactsForResume.storageOutput,
      BigInt(manifest.resume.filecoinGenesis),
      "VeriarfyStorage",
    );
    const storage = await ethers.getContractAt("VeriarfyStorage", manifest.resume.storageAddress);
    mustAddress(await storage.owner(), manifest.deployer, "storage.owner");
    mustBigInt(await storage.filecoinGenesis(), manifest.resume.filecoinGenesis, "storage.filecoinGenesis");
    mustAddress(
      await storage.attestor(),
      boundaryState.storageAttestorConfigured ? manifest.deployer : ZeroAddress,
      "storage.attestor",
    );
  }
}

async function assertSignerAndNonce(
  manifest: D15ResumeManifest,
  signer: AnyContract,
  expectedNonce: number,
): Promise<void> {
  await assertContext(manifest, signer);
  const latest = await ethers.provider.getTransactionCount(manifest.deployer, "latest");
  const pending = await ethers.provider.getTransactionCount(manifest.deployer, "pending");
  assertResumeNonce(latest, pending, expectedNonce);
}

async function assertAdvancedNonce(manifest: D15ResumeManifest, expectedNonce: number): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = await ethers.provider.getTransactionCount(manifest.deployer, "latest");
    const pending = await ethers.provider.getTransactionCount(manifest.deployer, "pending");
    if (latest === expectedNonce && pending === expectedNonce) return;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const latest = await ethers.provider.getTransactionCount(manifest.deployer, "latest");
  const pending = await ethers.provider.getTransactionCount(manifest.deployer, "pending");
  assertResumeNonce(latest, pending, expectedNonce);
}

async function sendBound<T>(
  manifest: D15ResumeManifest,
  signer: AnyContract,
  expectedNonce: number,
  label: string,
  before: () => Promise<void>,
  send: (nonce: number) => Promise<{ tx: Tx; value?: T }>,
): Promise<T | undefined> {
  await assertSignerAndNonce(manifest, signer, expectedNonce);
  await before();
  const result = await send(expectedNonce);
  if (result.tx.nonce !== expectedNonce) {
    throw new Error(`${label} transaction nonce ${result.tx.nonce}; ${expectedNonce} bekleniyordu`);
  }
  const receipt = await result.tx.wait();
  if (!receipt || Number(receipt.status ?? 0) !== 1) throw new Error(`${label} receipt basarisiz`);
  await assertAdvancedNonce(manifest, expectedNonce + 1);
  return result.value;
}

async function main(): Promise<void> {
  if (process.env.D15_PROFILE !== D15_PROFILE_ID) {
    throw new Error(`D15_PROFILE=${D15_PROFILE_ID} zorunludur`);
  }
  const manifest = loadD15ResumeManifest();
  const profile = loadD15Profile();
  if (!sameAddress(profile.deployer, manifest.deployer)) throw new Error("D15 deployer manifest/profile farkli");
  const studyEnvPath = join(__dirname, "..", "study", "deploy-env.json");
  const study = loadStudyConfig(studyEnvPath, { requireMetrics: true });
  const metrics = study.metrics;
  if (!metrics || !study.metricsFile || !study.metricsSpecHash) {
    throw new Error("D15 resume metrik paneli eksik");
  }
  const metricsHash = String(study.env.METRICS_HASH ?? "").toLowerCase();
  const metricsSpecDigest = study.metricsSpecHash;
  const metricsUri = String(study.env.METRICS_URI ?? "");
  if (
    metricsHash !== manifest.resume.metricsHash ||
    metricsSpecDigest !== manifest.resume.metricsSpecHash ||
    metricsUri !== manifest.resume.metricsUri
  ) {
    throw new Error("D15 resume metrics hash/uri manifest ile eslesmiyor");
  }
  if (Number(study.env.SNP_COUNT) !== manifest.resume.snpCount) {
    throw new Error("D15 resume SNP_COUNT manifest ile eslesmiyor");
  }
  const artifactsForResume = await readArtifactChecks(manifest);
  const execute = process.env.D15_EXECUTION_ACK === "resume";
  const signers = await ethers.getSigners();
  if (!execute && signers.length !== 0) throw new Error("D15 resume check signer yuklememeli");
  if (execute && signers.length !== 1) throw new Error("D15 resume yalniz tek deployer signer kabul eder");
  await assertContext(manifest, execute ? signers[0] : undefined);
  const latest = await ethers.provider.getTransactionCount(manifest.deployer, "latest");
  const pending = await ethers.provider.getTransactionCount(manifest.deployer, "pending");
  const boundary = assertResumeBoundaryNonce(latest, pending);
  await assertBoundary(
    manifest,
    profile,
    metrics,
    metricsHash,
    metricsSpecDigest,
    metricsUri,
    artifactsForResume,
    boundary,
  );

  if (boundary < 24) {
    const balance = await ethers.provider.getBalance(manifest.deployer);
    if (balance < profile.minimumDeployerBalanceWei) {
      throw new Error("D15 deployer bakiyesi minimum resume esigini karsilamiyor");
    }
  }

  if (!execute) {
    console.log(`D15 resume read-only verification tamamlandi (boundary nonce ${boundary}); transaction gonderilmedi.`);
    return;
  }

  if (boundary === 24) {
    console.log("D15 resume nonce 24: final state dogrulandi; transaction gonderilmedi.");
    // Output regeneration below is the only write in this already-complete path.
  }

  const signer = signers[0];
  const contracts: Record<string, string> = {};
  for (const nonce of manifest.completedNonces) {
    const item = manifest.created[String(nonce)];
    if (item) contracts[item.name] = item.address;
  }
  const protocol: AnyContract = await ethers.getContractAt("VeriarfyProtocol", contracts.VeriarfyProtocol, signer);
  const biomarkers: AnyContract = await ethers.getContractAt(
    "VeriarfyBiomarkers",
    contracts.VeriarfyBiomarkers,
    signer,
  );
  const paymentsAddress = contracts.VeriarfyPayments;

  let nonce = boundary;
  if (nonce === 15) {
    await sendBound(
      manifest,
      signer,
      nonce,
      "configureMetrics",
      async () => {
        if ((await biomarkers.metricCount()) !== 0n || (await biomarkers.panelFrozen()))
          throw new Error("biomarkers metrik paneli baseline degil");
      },
      async (n) => ({
        tx: await biomarkers.configureMetrics(metrics, metricsHash, metricsUri, { nonce: n }),
      }),
    );
    nonce += 1;
    await assertBoundary(
      manifest,
      profile,
      metrics,
      metricsHash,
      metricsSpecDigest,
      metricsUri,
      artifactsForResume,
      nonce,
    );
  }
  if (nonce === 16) {
    await sendBound(
      manifest,
      signer,
      nonce,
      "setQueryGateway",
      async () => {
        mustZeroAddress(await protocol.queryGateway(), "protocol.queryGateway");
      },
      async (n) => ({
        tx: await protocol.setQueryGateway(paymentsAddress, { nonce: n }),
      }),
    );
    nonce += 1;
    await assertBoundary(
      manifest,
      profile,
      metrics,
      metricsHash,
      metricsSpecDigest,
      metricsUri,
      artifactsForResume,
      nonce,
    );
  }

  let staking: AnyContract | undefined =
    nonce >= 18 ? await ethers.getContractAt("VeriarfyStaking", manifest.resume.stakingAddress, signer) : undefined;
  if (nonce === 17) {
    const Staking = await ethers.getContractFactory("VeriarfyStaking", signer);
    staking = await sendBound(
      manifest,
      signer,
      nonce,
      "deploy staking",
      async () => {
        if ((await ethers.provider.getCode(manifest.resume.stakingAddress)) !== "0x")
          throw new Error("staking deterministic adresi zaten dolu");
      },
      async (n) => {
        const deployed: AnyContract = await Staking.deploy(
          manifest.deployer,
          contracts.VeriarfyProtocol,
          BigInt(manifest.resume.baseStakeWei),
          BigInt(manifest.resume.valueThreshold),
          { nonce: n },
        );
        const tx = deployed.deploymentTransaction();
        if (!tx) throw new Error("staking deployment transaction yok");
        return { tx, value: deployed };
      },
    );
    if (!staking) throw new Error("staking deployment sonucu yok");
    mustAddress(await staking.getAddress(), manifest.resume.stakingAddress, "staking address");
    nonce += 1;
    await assertBoundary(
      manifest,
      profile,
      metrics,
      metricsHash,
      metricsSpecDigest,
      metricsUri,
      artifactsForResume,
      nonce,
    );
  }
  if (nonce === 18) {
    if (!staking) throw new Error("staking boundary contract yok");
    await sendBound(
      manifest,
      signer,
      nonce,
      "staking.setPayments",
      async () => {
        mustZeroAddress(await staking.payments(), "staking.payments");
      },
      async (n) => ({
        tx: await staking.setPayments(paymentsAddress, { nonce: n }),
      }),
    );
    nonce += 1;
    await assertBoundary(
      manifest,
      profile,
      metrics,
      metricsHash,
      metricsSpecDigest,
      metricsUri,
      artifactsForResume,
      nonce,
    );
  }
  if (nonce === 19) {
    if (!staking) throw new Error("staking boundary contract yok");
    await sendBound(
      manifest,
      signer,
      nonce,
      "protocol.setStakingModule",
      async () => {
        mustZeroAddress(await protocol.stakingModule(), "protocol.stakingModule");
      },
      async (n) => ({
        tx: await protocol.setStakingModule(await staking.getAddress(), {
          nonce: n,
        }),
      }),
    );
    nonce += 1;
    await assertBoundary(
      manifest,
      profile,
      metrics,
      metricsHash,
      metricsSpecDigest,
      metricsUri,
      artifactsForResume,
      nonce,
    );
  }
  if (nonce === 20) {
    await sendBound(
      manifest,
      signer,
      nonce,
      "protocol.setChallengePeriod",
      async () => {
        mustBigInt(await protocol.challengePeriod(), "0", "protocol.challengePeriod");
      },
      async (n) => ({
        tx: await protocol.setChallengePeriod(BigInt(manifest.resume.challengePeriod), { nonce: n }),
      }),
    );
    nonce += 1;
    await assertBoundary(
      manifest,
      profile,
      metrics,
      metricsHash,
      metricsSpecDigest,
      metricsUri,
      artifactsForResume,
      nonce,
    );
  }
  if (nonce === 21) {
    await sendBound(
      manifest,
      signer,
      nonce,
      "protocol.setLivenessTimeout",
      async () => {
        mustBigInt(await protocol.livenessTimeout(), "0", "protocol.livenessTimeout");
      },
      async (n) => ({
        tx: await protocol.setLivenessTimeout(BigInt(manifest.resume.livenessTimeout), { nonce: n }),
      }),
    );
    nonce += 1;
    await assertBoundary(
      manifest,
      profile,
      metrics,
      metricsHash,
      metricsSpecDigest,
      metricsUri,
      artifactsForResume,
      nonce,
    );
  }

  let storage: AnyContract | undefined =
    nonce >= 23 ? await ethers.getContractAt("VeriarfyStorage", manifest.resume.storageAddress, signer) : undefined;
  if (nonce === 22) {
    const Storage = await ethers.getContractFactory("VeriarfyStorage", signer);
    storage = await sendBound(
      manifest,
      signer,
      nonce,
      "deploy storage",
      async () => {
        if ((await ethers.provider.getCode(manifest.resume.storageAddress)) !== "0x")
          throw new Error("storage deterministic adresi zaten dolu");
      },
      async (n) => {
        const deployed: AnyContract = await Storage.deploy(manifest.deployer, BigInt(manifest.resume.filecoinGenesis), {
          nonce: n,
        });
        const tx = deployed.deploymentTransaction();
        if (!tx) throw new Error("storage deployment transaction yok");
        return { tx, value: deployed };
      },
    );
    if (!storage) throw new Error("storage deployment sonucu yok");
    mustAddress(await storage.getAddress(), manifest.resume.storageAddress, "storage address");
    nonce += 1;
    await assertBoundary(
      manifest,
      profile,
      metrics,
      metricsHash,
      metricsSpecDigest,
      metricsUri,
      artifactsForResume,
      nonce,
    );
  }
  if (nonce === 23) {
    if (!storage) throw new Error("storage boundary contract yok");
    await sendBound(
      manifest,
      signer,
      nonce,
      "storage.setAttestor",
      async () => {
        mustAddress(await storage.attestor(), ZeroAddress, "storage.attestor");
      },
      async (n) => ({
        tx: await storage.setAttestor(manifest.deployer, { nonce: n }),
      }),
    );
    nonce += 1;
    await assertBoundary(
      manifest,
      profile,
      metrics,
      metricsHash,
      metricsSpecDigest,
      metricsUri,
      artifactsForResume,
      nonce,
    );
  }
  if (nonce !== 24) throw new Error(`D15 resume beklenmeyen son nonce: ${nonce}`);

  const output = {
    network: manifest.network,
    chainId: manifest.chainId,
    deployer: manifest.deployer,
    authorizedNodes: profile.authorizedNodes,
    contracts: {
      Groth16Verifier: contracts.Groth16Verifier,
      DataProvenanceVerifier: contracts.DataProvenanceVerifier,
      VeriarfyProtocol: contracts.VeriarfyProtocol,
      VeriarfyPayments: contracts.VeriarfyPayments,
      VeriarfyBiomarkers: contracts.VeriarfyBiomarkers,
      VeriarfyStaking: manifest.resume.stakingAddress,
      VeriarfyStorage: manifest.resume.storageAddress,
      PaymentToken: contracts.StableTestToken,
      VeriArfyRegistry: contracts.VeriArfyRegistry,
      AnxietyStudy: contracts.AnxietyStudy,
    },
    paymentTokenIsTestToken: true,
    liquidityShareBps: 8000,
    initialRoot: manifest.expected.registryRoot,
    accreditedRoot: manifest.expected.protocol.accreditedRoot,
    deployedAt: manifest.resume.deployedAt,
    deployedAtBlock: manifest.resume.deployedAtBlock,
  };

  const deploymentPath = join(__dirname, "..", "deployments", "sepolia.json");
  const webPath = join(__dirname, "..", "..", "web", "src", "config", "deployment.json");
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  publishD15OutputPair([deploymentPath, webPath], serialized);
  console.log("D15 resume tamamlandi; deployment ve web adresleri yazildi.");
}

main().catch((error) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`D15 resume BASARISIZ: ${detail}`);
  process.exit(1);
});
