/**
 * E/18 sentetik cohort zincir on-kontrolu.
 *
 * Salt-okunurdur: signer istemez, cüzdan üretmez, fon veya FHE girdi işlemi
 * göndermez. Cohort çalıştırıcısından önce dağıtım topolojisinin ve gerçek
 * fhEVM coprocessor kaydının hâlâ geçerli olduğunu kanıtlar.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ethers, fhevm, network } from "hardhat";

const CHAIN_ID = 11155111n;
const PROFILE = "e18-synthetic-bmi-snp-v1";

function fail(message: string): never {
  throw new Error(`E18 preflight: ${message}`);
}

function record(): any {
  const path = join(__dirname, "..", "deployments", "e18-sepolia.json");
  let parsed: any;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { fail(`deployment kaydi okunamadi: ${path}`); }
  if (parsed.network !== "sepolia" || BigInt(parsed.chainId) !== CHAIN_ID || parsed.profile !== PROFILE || parsed.syntheticOnly !== true) {
    fail("sentetik E/18 deployment profili gecersiz");
  }
  for (const name of ["DataProvenanceVerifier", "ContingencyStats", "CoverageBits", "VeriarfyProtocolE18", "BiomarkerStats", "VeriarfyBiomarkers"]) {
    if (!ethers.isAddress(parsed.contracts?.[name])) fail(`contract adresi gecersiz: ${name}`);
  }
  return parsed;
}

async function main() {
  if (network.name !== "sepolia") fail("yalniz Sepolia kabul edilir");
  const chain = await ethers.provider.getNetwork();
  if (chain.chainId !== CHAIN_ID) fail(`chainId ${chain.chainId}; ${CHAIN_ID} bekleniyor`);
  const deployment = record();
  const protocol = await ethers.getContractAt("VeriarfyProtocolE18", deployment.contracts.VeriarfyProtocolE18);
  const biomarkers = await ethers.getContractAt("VeriarfyBiomarkers", deployment.contracts.VeriarfyBiomarkers);
  const [policy, minimum, snps, panelHash, panelUri, module, metricCount, metricsHash, metricsUri, nodes, gateway] = await Promise.all([
    protocol.e18DisclosurePolicyActive(), protocol.minParticipants(), protocol.snpCount(), protocol.panelHash(), protocol.panelUri(), protocol.biomarkerModule(),
    biomarkers.metricCount(), biomarkers.metricsHash(), biomarkers.metricsUri(), protocol.authorizedNodeCount(), protocol.queryGateway(),
  ]);
  const expectedHash = ethers.id(PROFILE);
  if (!policy || minimum !== 60n || snps !== 1n || panelHash !== expectedHash || panelUri !== `ipfs://${PROFILE}` ||
      module.toLowerCase() !== deployment.contracts.VeriarfyBiomarkers.toLowerCase() || metricCount !== 1n || metricsHash !== expectedHash || metricsUri !== `ipfs://${PROFILE}` ||
      nodes !== 2n || gateway.toLowerCase() !== deployment.deployer.toLowerCase()) {
    fail("zincir E/18 panel/gateway politikasi deployment kaydiyla uyusmuyor");
  }
  const code = await Promise.all(Object.values(deployment.contracts).map((address) => ethers.provider.getCode(String(address))));
  if (code.some((value) => value === "0x")) fail("deployment kaydindaki en az bir kontrat kodsuz");

  // Canlı relayer/KMS istemcisi gerçekten başlatılmadan wallet/fund aşamasına geçilmez.
  await fhevm.initializeCLIApi();
  await fhevm.assertCoprocessorInitialized(deployment.contracts.VeriarfyProtocolE18, "VeriarfyProtocolE18");
  await fhevm.assertCoprocessorInitialized(deployment.contracts.VeriarfyBiomarkers, "VeriarfyBiomarkers");

  console.log(JSON.stringify({
    pass: true,
    network: network.name,
    chainId: chain.chainId.toString(),
    profile: PROFILE,
    participantCount: (await protocol.participantCount()).toString(),
    minParticipants: minimum.toString(),
    fhEvmMock: fhevm.isMock,
    contracts: deployment.contracts,
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
