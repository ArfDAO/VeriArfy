/**
 * Circom derleyicisini indirir (platforma gore) ve packages/circuits/bin altina koyar.
 * Zaten PATH'te circom varsa onu kullanir.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_DIR = join(__dirname, "..", "bin");
const CIRCOM_VERSION = "v2.2.3";

/** Sistemde kurulu circom varsa yolunu doner. */
function systemCircom() {
  try {
    const path = execFileSync("which", ["circom"], { encoding: "utf8" }).trim();
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

function assetName() {
  const { platform, arch } = process;
  if (platform === "darwin") {
    // Apple Silicon icin de macos-amd64 dosyasi yayinlaniyor (arm64 Mach-O).
    return "circom-macos-amd64";
  }
  if (platform === "linux") {
    if (arch !== "x64") {
      throw new Error(`Desteklenmeyen Linux mimarisi: ${arch}. circom'u kaynaktan derleyin.`);
    }
    return "circom-linux-amd64";
  }
  if (platform === "win32") {
    return "circom-windows-amd64.exe";
  }
  throw new Error(`Desteklenmeyen platform: ${platform}`);
}

export async function ensureCircom() {
  const fromSystem = systemCircom();
  if (fromSystem) {
    return fromSystem;
  }

  const target = join(BIN_DIR, process.platform === "win32" ? "circom.exe" : "circom");
  if (existsSync(target)) {
    return target;
  }

  mkdirSync(BIN_DIR, { recursive: true });

  const url = `https://github.com/iden3/circom/releases/download/${CIRCOM_VERSION}/${assetName()}`;
  console.log(`circom indiriliyor: ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`circom indirilemedi (${res.status} ${res.statusText})`);
  }

  await writeFile(target, Buffer.from(await res.arrayBuffer()));
  chmodSync(target, 0o755);

  console.log(`circom hazir: ${target}`);
  return target;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = await ensureCircom();
  execFileSync(path, ["--version"], { stdio: "inherit" });
}
