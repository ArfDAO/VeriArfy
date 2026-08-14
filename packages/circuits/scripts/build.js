/**
 * Devreleri derler, Groth16 anahtarlarini uretir ve Solidity verifier'lari yazar.
 *
 * Her devre icin:
 *   1. <ad>.circom              -> r1cs + wasm
 *   2. powersOfTau (indirilir)  -> <ad>_final.zkey
 *   3. zkey                     -> <ad>_verification_key.json + <Ad>Verifier.sol
 *
 * NOT: Uretilen zkey tek katilimcili bir "development ceremony" ciktisidir.
 * Mainnet icin cok katilimcili bir toren (MPC) sarttir.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import * as snarkjs from "snarkjs";

import { ensureCircom } from "./fetch-circom.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BUILD = join(ROOT, "build");
const PTAU_DIR = join(ROOT, "ptau");
const VERIFIER_DIR = join(ROOT, "..", "contracts", "contracts", "verifiers");

/**
 * Uretilen devreler.
 *
 * `solidityName` kasitli olarak devre adindan turetilmiyor: uretilen dosya
 * zincire deploy edilen kontratin adidir ve deploy betikleriyle testler bu
 * ada gore arar. Devre adi degisirse bile kontrat adi sabit kalmalidir.
 */
const CIRCUITS = [
  { name: "researcher_identity", solidityName: "Groth16Verifier" },
  { name: "data_provenance", solidityName: "DataProvenanceVerifier" },
];

/**
 * 2^15 = 32.768 kisit kapasitesi.
 *
 * OLCULEN kullanim (`snarkjs r1cs info`):
 *   researcher_identity :  11.435
 *   data_provenance     :  20.088   <- EdDSA dogrulamasi + 20 seviyeli Merkle
 *
 * 2^14 (16.384) ile baslanmisti ve data_provenance sigmadi. Belirti yaniltici:
 * `newZKey` acik bir "devre cok buyuk" hatasi vermiyor, bozuk bir zkey yazip
 * geciyor; hata bir sonraki adimda "Invalid File format" olarak cikiyor.
 * Devre buyudugunde once buraya bakin.
 */
const PTAU_FILE = "powersOfTau28_hez_final_15.ptau";
const PTAU_URL = `https://storage.googleapis.com/zkevm/ptau/${PTAU_FILE}`;

async function downloadPtau() {
  const target = join(PTAU_DIR, PTAU_FILE);
  if (existsSync(target)) {
    console.log(`ptau mevcut: ${target}`);
    return target;
  }

  mkdirSync(PTAU_DIR, { recursive: true });
  console.log(`ptau indiriliyor (~19MB): ${PTAU_URL}`);

  const res = await fetch(PTAU_URL);
  if (!res.ok || !res.body) {
    throw new Error(`ptau indirilemedi (${res.status} ${res.statusText})`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(target));

  console.log(`ptau hazir: ${target}`);
  return target;
}

async function compileCircuit(circomPath, name) {
  mkdirSync(BUILD, { recursive: true });

  const args = [
    join(ROOT, "circuits", `${name}.circom`),
    "--r1cs",
    "--wasm",
    "--sym",
    "-o",
    BUILD,
    // Devrelerin kendi `lib/` dosyalarini bulabilmesi icin.
    "-l",
    join(ROOT, "circuits"),
    "-l",
    join(ROOT, "node_modules"),
    // npm workspaces bagimliligi koke kaldirabilir
    "-l",
    join(ROOT, "..", "..", "node_modules"),
  ];

  console.log(`\n[${name}] derleniyor...`);
  execFileSync(circomPath, args, { stdio: "inherit" });
}

async function generateKeys(ptauPath, name) {
  const r1cs = join(BUILD, `${name}.r1cs`);
  const zkey0 = join(BUILD, `${name}_0000.zkey`);
  const zkeyFinal = join(BUILD, `${name}_final.zkey`);
  const vkeyPath = join(BUILD, `${name}_verification_key.json`);

  // Anahtarlar pahali; varsa yeniden uretme (FORCE_SETUP=1 ile zorlanabilir).
  if (existsSync(zkeyFinal) && existsSync(vkeyPath) && !process.env.FORCE_SETUP) {
    console.log(`[${name}] anahtarlar mevcut (yeniden uretmek icin FORCE_SETUP=1)`);
    return zkeyFinal;
  }

  console.log(`[${name}] groth16 setup...`);
  await snarkjs.zKey.newZKey(r1cs, ptauPath, zkey0);

  console.log(`[${name}] katki (development ceremony)...`);
  await snarkjs.zKey.contribute(zkey0, zkeyFinal, "veriarfy-dev", `veriarfy-${Date.now()}`);

  const vkey = await snarkjs.zKey.exportVerificationKey(zkeyFinal);
  await writeFile(vkeyPath, JSON.stringify(vkey, null, 2));

  console.log(`[${name}] anahtarlar hazir`);
  return zkeyFinal;
}

/** snarkjs sablonunu bulur; npm workspaces paketi koke kaldirabiliyor. */
function verifierTemplatePath() {
  const require = createRequire(import.meta.url);
  const snarkjsRoot = dirname(require.resolve("snarkjs"));
  const candidates = [
    join(snarkjsRoot, "templates", "verifier_groth16.sol.ejs"),
    join(snarkjsRoot, "..", "templates", "verifier_groth16.sol.ejs"),
  ];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`snarkjs verifier sablonu bulunamadi. Bakilan yollar:\n${candidates.join("\n")}`);
  }
  return found;
}

async function exportVerifier(zkeyPath, { name, solidityName }, templatePath) {
  const templates = { groth16: await readFile(templatePath, "utf8") };

  let solidity = await snarkjs.zKey.exportSolidityVerifier(zkeyPath, templates);

  // snarkjs sablonu eski pragma ile geliyor; hardhat surumumuze hizala.
  solidity = solidity.replace(/pragma solidity .*;/, "pragma solidity ^0.8.24;");

  // Sablon kontrati her zaman "Groth16Verifier" olarak adlandirir. Iki devre
  // ayni ada sahip olamaz; aksi halde hardhat "birden fazla artefakt" hatasi
  // verir ve deploy betigi hangisini istedigini soyleyemez.
  if (solidityName !== "Groth16Verifier") {
    solidity = solidity.replace(/contract Groth16Verifier\b/, `contract ${solidityName}`);
  }

  const out = join(VERIFIER_DIR, `${solidityName}.sol`);
  mkdirSync(VERIFIER_DIR, { recursive: true });
  await writeFile(out, solidity);

  console.log(`[${name}] verifier yazildi: ${solidityName}.sol`);
}

async function main() {
  const circomPath = await ensureCircom();
  const ptauPath = await downloadPtau();
  const templatePath = verifierTemplatePath();

  for (const circuit of CIRCUITS) {
    await compileCircuit(circomPath, circuit.name);
    const zkeyPath = await generateKeys(ptauPath, circuit.name);
    await exportVerifier(zkeyPath, circuit, templatePath);
  }

  console.log("\nbuild tamam.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
