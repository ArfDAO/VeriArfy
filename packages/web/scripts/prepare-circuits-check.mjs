import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { prepareCircuits } from "./prepare-circuits.js";

const names = [
  ["identity", "wasm", "researcher_identity.wasm", ["researcher_identity_js", "researcher_identity.wasm"]],
  ["identity", "zkey", "researcher_identity_final.zkey", ["researcher_identity_final.zkey"]],
  ["provenance", "wasm", "data_provenance.wasm", ["data_provenance_js", "data_provenance.wasm"]],
  ["provenance", "zkey", "data_provenance_final.zkey", ["data_provenance_final.zkey"]],
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "veriarfy-circuits-test-"));
  const build = join(root, "build");
  const out = join(root, "public", "circuits");
  const lockPath = join(root, "artifacts.lock.json");
  const pins = { identity: { sha256: {} }, provenance: { sha256: {} } };
  for (const [key, kind, name, parts] of names) {
    const source = join(build, ...parts);
    const data = Buffer.from(`${key}/${kind}/pinned`);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, data);
    pins[key].sha256[kind] = createHash("sha256").update(data).digest("hex");
    assert.equal(name.endsWith(kind === "wasm" ? ".wasm" : ".zkey"), true);
  }
  writeFileSync(lockPath, JSON.stringify({ version: 1, circuits: pins }));
  return { root, build, out, lockPath };
}

function runCase(callback) {
  const paths = fixture();
  try {
    callback(paths);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
}

test("copies only lock-matching build artifacts when public files are missing", () => runCase(({ build, out, lockPath }) => {
  const result = prepareCircuits({ buildDir: build, outDir: out, lockPath, log: () => {} });
  assert.equal(result.copied, true);
  for (const [, , name] of names) assert.match(readFileSync(join(out, name), "utf8"), /\/pinned$/);
}));

test("refuses corrupted served output and preserves it", () => runCase(({ build, out, lockPath }) => {
  prepareCircuits({ buildDir: build, outDir: out, lockPath, log: () => {} });
  const target = join(out, "researcher_identity_final.zkey");
  writeFileSync(target, "corrupt");
  assert.throws(() => prepareCircuits({ buildDir: build, outDir: out, lockPath, log: () => {} }), /refusing to overwrite/);
  assert.equal(readFileSync(target, "utf8"), "corrupt");
}));

test("rejects unpinned build source without creating public output", () => runCase(({ build, out, lockPath }) => {
  writeFileSync(join(build, "researcher_identity_final.zkey"), "random");
  assert.throws(() => prepareCircuits({ buildDir: build, outDir: out, lockPath, log: () => {} }), /hash-verified build sources/);
}));
