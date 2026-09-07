/** Prepare the frozen D/15 circuit artifacts served by the web package. */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUILD = join(__dirname, "..", "..", "circuits", "build");
const DEFAULT_OUT = join(__dirname, "..", "public", "circuits");
const DEFAULT_LOCK = join(DEFAULT_BUILD, "..", "artifacts.lock.json");

const FILES = [
  { key: "identity", source: "researcher_identity.wasm", build: ["researcher_identity_js", "researcher_identity.wasm"] },
  { key: "identity", source: "researcher_identity_final.zkey", build: ["researcher_identity_final.zkey"] },
  { key: "provenance", source: "data_provenance.wasm", build: ["data_provenance_js", "data_provenance.wasm"] },
  { key: "provenance", source: "data_provenance_final.zkey", build: ["data_provenance_final.zkey"] },
];

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function expectedFiles(lock) {
  return FILES.map((file) => {
    const expected = lock?.circuits?.[file.key]?.sha256;
    const hash = expected?.[file.source.endsWith(".wasm") ? "wasm" : "zkey"];
    if (!/^[a-f0-9]{64}$/i.test(hash ?? "")) {
      throw new Error(`artifacts.lock.json pin missing: ${file.key}/${file.source}`);
    }
    return { ...file, hash: hash.toLowerCase() };
  });
}

function mismatchLabel(path, expected, actual) {
  return `${path} (expected ${expected}, got ${actual})`;
}

export function prepareCircuits({
  buildDir = DEFAULT_BUILD,
  outDir = DEFAULT_OUT,
  lockPath = DEFAULT_LOCK,
  log = console.log,
} = {}) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const files = expectedFiles(lock).map((file) => ({
    ...file,
    outPath: join(outDir, file.source),
    buildPath: join(buildDir, ...file.build),
  }));

  const servedMismatches = files
    .filter((file) => existsSync(file.outPath))
    .map((file) => {
      const actual = sha256File(file.outPath);
      return actual === file.hash ? null : mismatchLabel(file.outPath, file.hash, actual);
    })
    .filter(Boolean);
  if (servedMismatches.length) {
    throw new Error(`Pinned public circuit artifact mismatch; refusing to overwrite:\n${servedMismatches.join("\n")}`);
  }

  const missing = files.filter((file) => !existsSync(file.outPath));
  if (!missing.length) {
    log("Pinned circuit artifacts verified; build outputs ignored.");
    return { copied: false, files: files.map((file) => file.source) };
  }

  const sourceErrors = files
    .map((file) => {
      if (!existsSync(file.buildPath)) return `${file.buildPath} (missing)`;
      const actual = sha256File(file.buildPath);
      return actual === file.hash ? null : mismatchLabel(file.buildPath, file.hash, actual);
    })
    .filter(Boolean);
  if (sourceErrors.length) {
    throw new Error(`Missing pinned public artifacts and no hash-verified build sources:\n${sourceErrors.join("\n")}`);
  }

  mkdirSync(outDir, { recursive: true });
  const staging = mkdtempSync(join(outDir, ".prepare-circuits-"));
  try {
    for (const file of files) {
      const staged = join(staging, file.source);
      copyFileSync(file.buildPath, staged);
      if (sha256File(staged) !== file.hash) throw new Error(`staged circuit artifact changed during copy: ${file.source}`);
    }
    for (const file of missing) {
      try {
        copyFileSync(join(staging, file.source), file.outPath, constants.COPYFILE_EXCL);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (sha256File(file.outPath) !== file.hash) throw new Error(`served artifact appeared with an unexpected hash: ${file.outPath}`);
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const finalErrors = files
    .filter((file) => !existsSync(file.outPath) || sha256File(file.outPath) !== file.hash)
    .map((file) => file.outPath);
  if (finalErrors.length) throw new Error(`circuit output verification failed:\n${finalErrors.join("\n")}`);
  for (const file of missing) log(`copied verified circuit: public/circuits/${file.source}`);
  return { copied: true, files: files.map((file) => file.source) };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    prepareCircuits();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
