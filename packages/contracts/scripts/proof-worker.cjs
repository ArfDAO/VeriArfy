"use strict";

const { isAbsolute } = require("node:path");

const MAX_INPUT_BYTES = 4 * 1024 * 1024;

function fail() {
  process.stderr.write("proof worker failed\n");
  process.exitCode = 1;
}

function readInput() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) {
        reject(new Error("input exceeds the proof worker limit"));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.once("error", reject);
    process.stdin.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function main() {
  const [, scriptPath, wasmPath, zkeyPath] = process.argv;
  if (scriptPath !== __filename) {
    throw new Error("invalid worker invocation");
  }
  if (!wasmPath || !zkeyPath || !isAbsolute(wasmPath) || !isAbsolute(zkeyPath)) {
    throw new Error("absolute wasm and zkey paths are required");
  }

  const raw = await readInput();
  if (!raw.trim()) throw new Error("empty input");

  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    throw new Error("invalid input JSON");
  }

  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("input must be a JSON object");
  }

  const snarkjs = require("snarkjs");
  const result = await snarkjs.groth16.fullProve(
    request,
    wasmPath,
    zkeyPath,
    undefined,
    undefined,
    { singleThread: true },
  );

  if (!result || typeof result !== "object" || !result.proof || !Array.isArray(result.publicSignals)) {
    throw new Error("snarkjs returned an invalid proof result");
  }

  process.stdout.write(JSON.stringify(result));
}

main().catch(fail);
