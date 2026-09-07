/**
 * Pin and verify the circuit artifacts used by the D/15 deployment.
 *
 * Running without arguments is strictly read-only. `--export` regenerates the
 * two Solidity verifiers from the already existing zkeys, then refreshes only
 * the verifier source hashes in the lock file. It never runs a circuit build
 * or setup ceremony.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as snarkjs from "snarkjs";
import { buildBn128 } from "ffjavascript";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const CIRCUITS_ROOT = resolve(SCRIPT_DIR, "..");
export const REPO_ROOT = resolve(CIRCUITS_ROOT, "..", "..");
export const LOCK_PATH = join(CIRCUITS_ROOT, "artifacts.lock.json");

export const ARTIFACTS = Object.freeze({
  identity: Object.freeze({
    name: "researcher_identity",
    solidityName: "Groth16Verifier",
    wasm: "packages/circuits/build/researcher_identity_js/researcher_identity.wasm",
    zkey: "packages/circuits/build/researcher_identity_final.zkey",
    vkey: "packages/circuits/build/researcher_identity_verification_key.json",
    verifier: "packages/contracts/contracts/verifiers/Groth16Verifier.sol",
  }),
  provenance: Object.freeze({
    name: "data_provenance",
    solidityName: "DataProvenanceVerifier",
    wasm: "packages/circuits/build/data_provenance_js/data_provenance.wasm",
    zkey: "packages/circuits/build/data_provenance_final.zkey",
    vkey: "packages/circuits/build/data_provenance_verification_key.json",
    verifier: "packages/contracts/contracts/verifiers/DataProvenanceVerifier.sol",
  }),
});

const templatePath = () => join(REPO_ROOT, "node_modules", "snarkjs", "templates", "verifier_groth16.sol.ejs");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256File(path, normalizeText = false) {
  const digest = createHash("sha256");
  const bytes = await readFile(path);
  digest.update(normalizeText ? bytes.toString("utf8").replace(/\r\n/g, "\n") : bytes);
  return digest.digest("hex");
}

export async function readManifest(path = LOCK_PATH) {
  return JSON.parse(await readFile(path, "utf8"));
}

function absolutePath(repoRoot, path) {
  return resolve(repoRoot, path);
}

async function expectedSolidity(artifact, repoRoot = REPO_ROOT) {
  const templates = { groth16: await readFile(templatePath(), "utf8") };
  let source = await snarkjs.zKey.exportSolidityVerifier(absolutePath(repoRoot, artifact.zkey), templates);
  source = source.replace(/pragma solidity .*;/, "pragma solidity ^0.8.24;");
  if (artifact.solidityName !== "Groth16Verifier") {
    source = source.replace(/contract Groth16Verifier\b/, `contract ${artifact.solidityName}`);
  }
  return source;
}

export async function checkArtifactHashes(artifact, pin, repoRoot = REPO_ROOT) {
  const errors = [];
  for (const kind of ["wasm", "zkey", "vkey", "verifier"]) {
    const path = absolutePath(repoRoot, artifact[kind]);
    if (!existsSync(path)) {
      errors.push(`${artifact.name} ${kind} missing: ${artifact[kind]}`);
      continue;
    }
    const actual = await sha256File(path, kind === "verifier");
    if (actual !== pin.sha256[kind]) {
      errors.push(`${artifact.name} ${kind} sha256 mismatch: expected ${pin.sha256[kind]}, got ${actual}`);
    }
  }
  return errors;
}

async function checkOne(artifact, pin, repoRoot, errors) {
  errors.push(...await checkArtifactHashes(artifact, pin, repoRoot));

  if (existsSync(absolutePath(repoRoot, artifact.zkey)) && existsSync(absolutePath(repoRoot, artifact.vkey))) {
    const actualVkey = await snarkjs.zKey.exportVerificationKey(absolutePath(repoRoot, artifact.zkey));
    const savedVkey = JSON.parse(await readFile(absolutePath(repoRoot, artifact.vkey), "utf8"));
    if (canonical(actualVkey) !== canonical(savedVkey)) {
      errors.push(`${artifact.name} verification key does not match zkey`);
    }
  }

  if (existsSync(absolutePath(repoRoot, artifact.zkey)) && existsSync(absolutePath(repoRoot, artifact.verifier))) {
    const generated = await expectedSolidity(artifact, repoRoot);
    const saved = await readFile(absolutePath(repoRoot, artifact.verifier), "utf8");
    if (generated.replace(/\r\n/g, "\n") !== saved.replace(/\r\n/g, "\n")) {
      errors.push(`${artifact.name} Solidity verifier does not match zkey`);
    }
  }
}

export async function checkArtifacts(options = {}) {
  return withSingleThreadCurve(() => checkArtifactsInner(options));
}

async function withSingleThreadCurve(action) {
  const previous = globalThis.curve_bn128;
  globalThis.curve_bn128 = await buildBn128(true);
  try { return await action(); }
  finally { globalThis.curve_bn128 = previous; }
}

async function checkArtifactsInner(options) {
  const manifest = options.manifest ?? await readManifest();
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const errors = [];
  const artifacts = options.artifacts ?? ARTIFACTS;
  for (const [key, artifact] of Object.entries(artifacts)) {
    if (!manifest.circuits?.[key]) errors.push(`${key} pin missing from manifest`);
    else await checkOne(artifact, manifest.circuits[key], repoRoot, errors);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return true;
}

export async function exportPinnedVerifiers({ repoRoot = REPO_ROOT, lockPath = LOCK_PATH } = {}) {
  return withSingleThreadCurve(() => exportPinnedVerifiersInner(repoRoot, lockPath));
}

async function exportPinnedVerifiersInner(repoRoot, lockPath) {
  const manifest = await readManifest(lockPath);
  const sources = [];
  // Validate all immutable inputs before modifying either source or the lock.
  for (const [key, artifact] of Object.entries(ARTIFACTS)) {
    for (const kind of ["wasm", "zkey", "vkey"]) {
      if (await sha256File(absolutePath(repoRoot, artifact[kind])) !== manifest.circuits[key].sha256[kind]) {
        throw new Error(`${artifact.name} ${kind} pin mismatch; export refused`);
      }
    }
    const vkey = await snarkjs.zKey.exportVerificationKey(absolutePath(repoRoot, artifact.zkey));
    if (canonical(vkey) !== canonical(JSON.parse(await readFile(absolutePath(repoRoot, artifact.vkey), "utf8")))) {
      throw new Error(`${artifact.name} vkey mismatch; export refused`);
    }
    const source = await expectedSolidity(artifact, repoRoot);
    sources.push({ key, artifact, source });
  }
  for (const { key, artifact, source } of sources) {
    const out = absolutePath(repoRoot, artifact.verifier);
    await writeFile(out, source);
    manifest.circuits[key].sha256.verifier = await sha256File(out, true);
  }
  await writeFile(lockPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.includes("--export")) await exportPinnedVerifiers();
    await checkArtifacts();
    console.log("circuit artifact pins verified");
  } catch (error) {
    console.error(`circuit artifact pin check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
