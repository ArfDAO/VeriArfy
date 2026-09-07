import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ARTIFACTS,
  checkArtifactHashes,
  checkArtifacts,
  exportPinnedVerifiers,
  readManifest,
  sha256File,
} from "./check-artifacts.mjs";

async function main() {
  await checkArtifacts();
  const manifest = await readManifest();
  for (const [key, artifact] of Object.entries(ARTIFACTS)) {
    assert.deepEqual(
      await checkArtifactHashes(artifact, manifest.circuits[key]),
      [],
      `${key} manifest matches actual files`,
    );
  }

  const root = await mkdtemp(join(tmpdir(), "veriarfy-artifact-pins-"));
  try {
    const artifact = {
      name: "fixture",
      wasm: "wasm.bin",
      zkey: "zkey.bin",
      vkey: "vkey.bin",
      verifier: "verifier.sol",
    };
    for (const [kind, path] of Object.entries(artifact)) {
      if (kind !== "name") await writeFile(join(root, path), `${kind}\n`);
    }
    const sha256 = {};
    for (const kind of ["wasm", "zkey", "vkey", "verifier"]) {
      sha256[kind] = await sha256File(join(root, artifact[kind]));
    }
    assert.deepEqual(await checkArtifactHashes(artifact, { sha256 }, root), []);
    await writeFile(join(root, artifact.verifier), "verifier\r\n");
    assert.deepEqual(await checkArtifactHashes(artifact, { sha256 }, root), [], "CRLF checkout preserves source pin");

    const mutated = { sha256: { ...sha256, wasm: "0".repeat(64) } };
    assert.match((await checkArtifactHashes(artifact, mutated, root)).join("\n"), /wasm sha256 mismatch/);

    await rm(join(root, artifact.verifier));
    assert.match((await checkArtifactHashes(artifact, { sha256 }, root)).join("\n"), /verifier missing/);

    const invalidManifest = structuredClone(manifest);
    invalidManifest.circuits.identity.sha256.wasm = "0".repeat(64);
    const invalidLock = join(root, "invalid-lock.json");
    await writeFile(invalidLock, JSON.stringify(invalidManifest));
    await assert.rejects(exportPinnedVerifiers({ lockPath: invalidLock }), /pin mismatch; export refused/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log("pinned artifact tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
