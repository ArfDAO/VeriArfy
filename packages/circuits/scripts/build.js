/**
 * Devreyi derler, Groth16 anahtarlarini uretir ve Solidity verifier'i yazar.
 *
 *   1. researcher_identity.circom  -> r1cs + wasm
 *   2. powersOfTau (indirilir)     -> researcher_identity_final.zkey
 *   3. zkey                        -> verification_key.json + Groth16Verifier.sol
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
const CIRCUIT = "researcher_identity";

// 2^14 kisit, 20 seviyeli agac icin fazlasiyla yeterli.
const PTAU_FILE = "powersOfTau28_hez_final_14.ptau";
const PTAU_URL = `https://storage.googleapis.com/zkevm/ptau/${PTAU_FILE}`;

const VERIFIER_OUT = join(ROOT, "..", "contracts", "contracts", "verifiers", "Groth16Verifier.sol");

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

async function compileCircuit(circomPath) {
  mkdirSync(BUILD, { recursive: true });

  const args = [
    join(ROOT, "circuits", `${CIRCUIT}.circom`),
    "--r1cs",
    "--wasm",
    "--sym",
    "-o",
    BUILD,
    "-l",
    join(ROOT, "node_modules"),
    // npm workspaces bagimliligi koke kaldirabilir
    "-l",
    join(ROOT, "..", "..", "node_modules"),
  ];

  console.log("devre derleniyor...");
  execFileSync(circomPath, args, { stdio: "inherit" });
}

async function generateKeys(ptauPath) {
  const r1cs = join(BUILD, `${CIRCUIT}.r1cs`);
  const zkey0 = join(BUILD, `${CIRCUIT}_0000.zkey`);
  const zkeyFinal = join(BUILD, `${CIRCUIT}_final.zkey`);
  const vkeyPath = join(BUILD, "verification_key.json");

  // Anahtarlar pahali; varsa yeniden uretme (FORCE_SETUP=1 ile zorlanabilir).
  if (existsSync(zkeyFinal) && existsSync(vkeyPath) && !process.env.FORCE_SETUP) {
    console.log(`anahtarlar mevcut: ${zkeyFinal} (yeniden uretmek icin FORCE_SETUP=1)`);
    return zkeyFinal;
  }

  console.log("groth16 setup...");
  await snarkjs.zKey.newZKey(r1cs, ptauPath, zkey0);

  console.log("katkı (development ceremony)...");
  await snarkjs.zKey.contribute(zkey0, zkeyFinal, "veriarfy-dev", `veriarfy-${Date.now()}`);

  const vkey = await snarkjs.zKey.exportVerificationKey(zkeyFinal);
  await writeFile(vkeyPath, JSON.stringify(vkey, null, 2));

  console.log(`anahtarlar hazir: ${zkeyFinal}`);
  return zkeyFinal;
}

async function exportVerifier(zkeyPath) {
  // npm workspaces snarkjs'i koke hoist edebilir; paket kokunu giris
  // dosyasindan turet ("./package.json" exports ile disari acilmiyor).
  const require = createRequire(import.meta.url);
  const snarkjsRoot = dirname(require.resolve("snarkjs"));
  const candidates = [
    join(snarkjsRoot, "templates", "verifier_groth16.sol.ejs"),
    join(snarkjsRoot, "..", "templates", "verifier_groth16.sol.ejs"),
  ];

  const templatePath = candidates.find((candidate) => existsSync(candidate));
  if (!templatePath) {
    throw new Error(`snarkjs verifier sablonu bulunamadi. Bakilan yollar:\n${candidates.join("\n")}`);
  }

  const templates = { groth16: await readFile(templatePath, "utf8") };

  let solidity = await snarkjs.zKey.exportSolidityVerifier(zkeyPath, templates);

  // snarkjs sablonu eski pragma ile geliyor; hardhat surumumuze hizala.
  solidity = solidity.replace(/pragma solidity .*;/, "pragma solidity ^0.8.24;");

  mkdirSync(dirname(VERIFIER_OUT), { recursive: true });
  await writeFile(VERIFIER_OUT, solidity);

  console.log(`verifier yazildi: ${VERIFIER_OUT}`);
}

async function main() {
  const circomPath = await ensureCircom();
  await compileCircuit(circomPath);

  const ptauPath = await downloadPtau();
  const zkeyPath = await generateKeys(ptauPath);
  await exportVerifier(zkeyPath);

  console.log("\nbuild tamam.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
