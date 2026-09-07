import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUST_VERSION = process.env.VERCEL_RUST_VERSION ?? "1.98.1";
const WASM_PACK_VERSION = process.env.VERCEL_WASM_PACK_VERSION ?? "0.13.1";
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
const cargoBin = join(cargoHome, "bin");
const buildEnv = {
  ...process.env,
  CARGO_HOME: cargoHome,
  PATH: [cargoBin, process.env.PATH].filter(Boolean).join(delimiter),
  RUSTUP_TOOLCHAIN: RUST_VERSION,
};

function run(command, args, env = buildEnv) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function has(command, env = buildEnv) {
  const result = spawnSync(command, ["--version"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "ignore", "ignore"],
    shell: false,
  });
  return result.status === 0;
}

function ensureRustup() {
  if (has("rustup")) return;
  if (process.platform === "win32") {
    throw new Error("Vercel Wasm build requires rustup; Windows is unsupported.");
  }
  // Vercel's Linux image normally includes rustup. This fallback bootstraps
  // rustup for a clean image; the installed toolchain below remains explicit.
  run("sh", ["-c", "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none"], {
    ...process.env,
    CARGO_HOME: cargoHome,
    PATH: [cargoBin, process.env.PATH].filter(Boolean).join(delimiter),
  });
}

function ensureToolchain() {
  ensureRustup();
  run("rustup", [
    "toolchain",
    "install",
    RUST_VERSION,
    "--profile",
    "minimal",
    "--target",
    "wasm32-unknown-unknown",
  ]);
}

function ensureWasmPack() {
  const expected = `wasm-pack ${WASM_PACK_VERSION}`;
  const version = spawnSync("wasm-pack", ["--version"], {
    cwd: ROOT,
    env: buildEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    shell: false,
  });
  if (version.status === 0 && version.stdout.trim() === expected) return;

  // cargo install is slower than a prebuilt binary but works on every Vercel
  // Linux architecture and is locked to the exact published dependency graph.
  run("cargo", [
    "install",
    "wasm-pack",
    "--version",
    `=${WASM_PACK_VERSION}`,
    "--locked",
  ]);
}

function main() {
  ensureToolchain();
  ensureWasmPack();
  run("npm", ["run", "wasm:build"]);
  run("npm", ["run", "fhe:build"]);
  if (process.argv.includes("--wasm-only")) return;
  run("npm", ["run", "web:build"]);
}

try {
  main();
} catch (error) {
  console.error(`Vercel build failed: ${error.message}`);
  process.exitCode = 1;
}
