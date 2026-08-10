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

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    contracts: {
      Groth16Verifier: verifierAddress,
      VeriArfyRegistry: registryAddress,
      AnxietyStudy: studyAddress,
    },
    initialRoot: initialRoot.toString(),
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
