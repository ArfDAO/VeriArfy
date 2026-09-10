"use strict";

/*
 * D/17's operator boundary.
 *
 * This file deliberately does not use dotenv.  The coordinator knows public
 * profile data and public participant addresses only.  A role child reads one
 * fixed secret file (or one DPAPI wallet), creates one signer environment, and
 * then loads the TypeScript engine in the contracts workspace.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const CONTRACTS_ROOT = path.join(REPO_ROOT, "packages", "contracts");
const ENGINE_PATH = path.join(CONTRACTS_ROOT, "scripts", "multi-participant-check.ts");
const PROFILE_PATH = path.join(CONTRACTS_ROOT, "ops", "d15-sepolia.json");
const DEPLOYMENT_PATH = path.join(CONTRACTS_ROOT, "deployments", "sepolia.json");
const DEFAULT_STATE_PATH = path.join(CONTRACTS_ROOT, "ops", "d17-live.json");
const MANIFEST_PATH = path.join(CONTRACTS_ROOT, "ops", "d17-wallets.json");
const WALLET_SCHEMA = "d17-wallet-v1";
const MANIFEST_SCHEMA = "d17-wallet-manifest-v1";
const ALLOWED_ROLES = /^(?:none|deployer|node-[12]|participant-[1-5])$/;
const PARTICIPANT_ROLE = /^participant-([1-5])$/;
const STAGE = /^[a-z][a-z0-9-]*$/;

const USER_ENV_FILES = Object.freeze({
  deployer: { file: ".env.d17.deployer", variable: "DEPLOYER_PRIVATE_KEY" },
  "node-1": { file: ".env.d17.node-1", variable: "NODE_PRIVATE_KEY" },
  "node-2": { file: ".env.d17.node-2", variable: "NODE_PRIVATE_KEY" },
});

// This child is the only process that sees a generated private key while it
// performs DPAPI protect/unprotect.  Its stdout is public metadata only for
// create; decrypt is used by a role child and never forwarded by the
// coordinator.
const WALLET_CHILD_SOURCE = String.raw`
"use strict";
const { spawnSync } = require("node:child_process");
const { Wallet, getAddress } = require("ethers");

function powershell(script, input) {
  const allowed = {};
  for (const key of ["SystemRoot", "Path", "PATH", "ComSpec", "TEMP", "TMP"]) {
    if (process.env[key]) allowed[key] = process.env[key];
  }
  const result = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
  ], { input, encoding: "utf8", windowsHide: true, shell: false, env: allowed, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("DPAPI operation failed");
  const output = String(result.stdout || "").trim();
  if (!output) throw new Error("DPAPI operation returned no value");
  return output;
}

function protect(value) {
  return powershell(
    "$plain = [Console]::In.ReadToEnd(); $secure = ConvertTo-SecureString $plain -AsPlainText -Force; ConvertFrom-SecureString $secure",
    value + "\n",
  );
}

function unprotect(ciphertext) {
  return powershell(
    "$cipher = [Console]::In.ReadToEnd().Trim(); $secure = ConvertTo-SecureString $cipher; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }",
    ciphertext + "\n",
  );
}

function main() {
  const mode = process.argv[1];
  if (mode === "create") {
    let wallet = Wallet.createRandom();
    const privateKey = wallet.privateKey;
    const address = getAddress(wallet.address);
    const ciphertext = protect(privateKey);
    const roundtrip = unprotect(ciphertext);
    if (getAddress(new Wallet(roundtrip).address) !== address) throw new Error("DPAPI address validation failed");
    wallet = null;
    process.stdout.write(JSON.stringify({ address, ciphertext }));
    return;
  }
  if (mode === "decrypt") {
    const item = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (!item || typeof item.ciphertext !== "string" || typeof item.address !== "string") {
      throw new Error("invalid encrypted wallet metadata");
    }
    const privateKey = unprotect(item.ciphertext);
    const address = getAddress(new Wallet(privateKey).address);
    if (address !== getAddress(item.address)) throw new Error("DPAPI address validation failed");
    process.stdout.write(JSON.stringify({ address, privateKey }));
    return;
  }
  if (mode === "validate") {
    const item = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (!item || typeof item.ciphertext !== "string" || typeof item.address !== "string") {
      throw new Error("invalid encrypted wallet metadata");
    }
    const privateKey = unprotect(item.ciphertext);
    const address = getAddress(new Wallet(privateKey).address);
    if (address !== getAddress(item.address)) throw new Error("DPAPI address validation failed");
    process.stdout.write(JSON.stringify({ address }));
    return;
  }
  throw new Error("unknown wallet operation");
}

try { main(); } catch (error) { process.stderr.write("wallet operation failed\n"); process.exitCode = 1; }
`;

function redactOutput(value) {
  let text = String(value ?? "");
  text = text.replace(/(["']?(?:private(?:Key|_key)?|secret|seed(?:Phrase|_phrase)?|mnemonic|witness|raw(?:Transaction|_transaction)|signed(?:Transaction|_transaction)|serialized)["']?\s*:\s*["']?)([^,"'\s}\]]+)/gi, "$1[REDACTED]");
  text = text.replace(/(private(?:Key|_key)?|secret|seed(?:Phrase|_phrase)?|mnemonic|witness|raw(?:Transaction|_transaction)|signed(?:Transaction|_transaction)|serialized)\s*[=:]\s*([^,\s}\]]+)/gi, "$1=[REDACTED]");
  text = text.replace(/^.*(?:private(?:Key|_key)?|secret|seed(?:Phrase|_phrase)?|mnemonic|witness|raw(?:Transaction|_transaction)|signed(?:Transaction|_transaction)|serialized).*$/gim, "[REDACTED]");
  text = text.replace(/(DEPLOYER_PRIVATE_KEY|NODE_PRIVATE_KEY|D17_PRIVATE_KEY)\s*=\s*[^\s&]+/gi, "$1=[REDACTED]");
  return text;
}

function safeError(error, fallback = "D17 launcher failed") {
  const message = error && typeof error.message === "string" ? error.message : fallback;
  return new Error(redactOutput(message));
}

function assertRole(role) {
  if (typeof role !== "string" || !ALLOWED_ROLES.test(role)) throw new Error("D17 role is invalid");
}

function assertStage(stage) {
  if (typeof stage !== "string" || !STAGE.test(stage)) throw new Error("D17 stage is invalid");
}

function parseArgs(argv) {
  const args = { role: "none", execute: false, initWallets: false, participants: 3, statePath: DEFAULT_STATE_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--execute") { args.execute = true; continue; }
    if (arg === "--init-wallets") { args.initWallets = true; continue; }
    if (arg === "--stage" || arg === "--role" || arg === "--state" || arg === "--participants") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} value is required`);
      if (arg === "--stage") args.stage = value;
      if (arg === "--role") args.role = value;
      if (arg === "--state") args.statePath = path.resolve(value);
      if (arg === "--participants") args.participants = Number(value);
      continue;
    }
    if (arg === "--help" || arg === "-h") { args.help = true; continue; }
    if (arg === "--child") { args.internal = "child"; continue; }
    throw new Error(`unknown D17 option: ${arg}`);
  }
  assertRole(args.role);
  if (args.help) return args;
  if (!Number.isInteger(args.participants) || args.participants < 3 || args.participants > 5) {
    throw new Error("D17 participants must be an integer from 3 to 5");
  }
  if (!args.initWallets) {
    if (!args.stage) throw new Error("D17 stage is required");
    assertStage(args.stage);
    if (args.role === "none" && args.execute) throw new Error("role none cannot execute");
  }
  return args;
}

function helpText() {
  return "node scripts/d17-sepolia.cjs --stage STAGE [--role deployer|node-1|node-2|participant-1..5|none] [--execute] [--state PATH]\n" +
    "node scripts/d17-sepolia.cjs --init-wallets [--participants 3..5]";
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw safeError(error, `cannot read public JSON: ${file}`); }
}

function loadPinnedPublic(repoRoot = REPO_ROOT) {
  const profile = readJson(path.join(repoRoot, "packages", "contracts", "ops", "d15-sepolia.json"));
  const deployment = readJson(path.join(repoRoot, "packages", "contracts", "deployments", "sepolia.json"));
  if (profile.network !== "sepolia" || Number(profile.chainId) !== 11155111 ||
      deployment.network !== "sepolia" || Number(deployment.chainId) !== 11155111 ||
      !/^https:\/\//.test(profile.publicRpcUrl) || !profile.deployer ||
      !Array.isArray(profile.authorizedNodes) || profile.authorizedNodes.length !== 2 ||
      !deployment.deployer || !deployment.contracts || !deployment.contracts.VeriarfyProtocol ||
      !deployment.contracts.VeriarfyPayments || !deployment.contracts.VeriarfyStaking ||
      !deployment.contracts.PaymentToken || !Array.isArray(deployment.authorizedNodes) ||
      deployment.authorizedNodes.length !== 2 || normalizeAddress(deployment.deployer) !== normalizeAddress(profile.deployer) ||
      normalizeAddress(deployment.authorizedNodes[0]) !== normalizeAddress(profile.authorizedNodes[0]) ||
      normalizeAddress(deployment.authorizedNodes[1]) !== normalizeAddress(profile.authorizedNodes[1])) {
    throw new Error("D17 public Sepolia profile/deployment is invalid");
  }
  return { profile, deployment };
}

function walletRoot(options = {}) {
  if (options.walletRoot) return path.resolve(options.walletRoot);
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "VeriArfy", "d17", "wallets");
}

function manifestPath(repoRoot = REPO_ROOT) {
  return path.join(repoRoot, "packages", "contracts", "ops", "d17-wallets.json");
}

function walletPath(role, options = {}) {
  assertRole(role);
  if (!PARTICIPANT_ROLE.test(role)) throw new Error("wallet path requires participant role");
  return path.join(walletRoot(options), `${role}.json`);
}

function spawnWalletWorker(mode, input, options = {}) {
  if (typeof options.walletWorker === "function") {
    const result = options.walletWorker(mode, input);
    if (mode === "validate" && result && Object.prototype.hasOwnProperty.call(result, "privateKey")) {
      throw new Error("D17 wallet validation returned private material");
    }
    return mode === "validate" ? { address: result?.address } : result;
  }
  if (process.platform !== "win32") throw new Error("D17 DPAPI wallets require Windows CurrentUser protection");
  const env = {};
  for (const key of ["SystemRoot", "Path", "PATH", "ComSpec", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const result = spawnSync(process.execPath, ["--max-old-space-size=128", "-e", WALLET_CHILD_SOURCE, mode], {
    cwd: REPO_ROOT,
    env,
    input: input || "",
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error("D17 wallet child failed");
  const output = String(result.stdout || "");
  if (mode === "validate" && /privateKey|private_key|D17_PRIVATE_KEY/i.test(output)) {
    throw new Error("D17 wallet validation returned private material");
  }
  try {
    const parsed = JSON.parse(output);
    return mode === "validate" ? { address: parsed.address } : parsed;
  }
  catch { throw new Error("D17 wallet child returned invalid public metadata"); }
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    fs.writeFileSync(temp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* preserve any prior target */ }
    throw safeError(error, "D17 atomic write failed");
  }
}

function normalizeAddress(value) {
  const { getAddress } = require("ethers");
  try { return getAddress(value); } catch { throw new Error("D17 wallet address is invalid"); }
}

function validateWalletMetadata(item, role) {
  if (!item || item.schema !== WALLET_SCHEMA || item.role !== role || typeof item.ciphertext !== "string") {
    throw new Error(`D17 encrypted wallet metadata invalid for ${role}`);
  }
  return { schema: WALLET_SCHEMA, role, address: normalizeAddress(item.address), ciphertext: item.ciphertext, createdAt: item.createdAt };
}

function validateManifest(manifest) {
  if (!manifest || manifest.schema !== MANIFEST_SCHEMA || manifest.network !== "sepolia" || Number(manifest.chainId) !== 11155111 || !Array.isArray(manifest.participants)) {
    throw new Error("D17 wallet manifest invalid");
  }
  const seenRoles = new Set();
  const seenAddresses = new Set();
  const participants = manifest.participants.map((item) => {
    assertRole(item.role);
    if (!PARTICIPANT_ROLE.test(item.role) || seenRoles.has(item.role)) throw new Error("D17 wallet manifest roles invalid");
    const address = normalizeAddress(item.address);
    if (seenAddresses.has(address.toLowerCase())) throw new Error("D17 wallet manifest addresses duplicate");
    seenRoles.add(item.role); seenAddresses.add(address.toLowerCase());
    return { role: item.role, address };
  }).sort((a, b) => a.role.localeCompare(b.role, undefined, { numeric: true }));
  return { schema: MANIFEST_SCHEMA, network: "sepolia", chainId: 11155111, createdAt: manifest.createdAt, participants };
}

function withWalletInitLock(root, fn) {
  const lockRoot = path.resolve(root);
  fs.mkdirSync(lockRoot, { recursive: true });
  const lockFile = path.join(lockRoot, ".d17-init.lock");
  let fd;
  try {
    fd = fs.openSync(lockFile, "wx");
    fs.writeFileSync(fd, `${process.pid}\n`, "utf8");
  } catch {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best effort */ } }
    throw new Error("D17 wallet initialization is already running");
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(lockFile); } catch { /* preserve no wallet data */ }
  }
}

function initWallets({ repoRoot = REPO_ROOT, participants = 3, walletRoot: injectedRoot, walletWorker, now = () => new Date().toISOString() } = {}) {
  if (!Number.isInteger(participants) || participants < 3 || participants > 5) throw new Error("D17 participants must be an integer from 3 to 5");
  const root = injectedRoot ? path.resolve(injectedRoot) : walletRoot();
  return withWalletInitLock(root, () => {
    const manifestFile = manifestPath(repoRoot);
    const existingManifest = fs.existsSync(manifestFile) ? validateManifest(readJson(manifestFile)) : null;
    const entries = new Map((existingManifest?.participants || []).map((item) => [item.role, item]));
    let highest = participants;
    for (const entry of entries.values()) highest = Math.max(highest, Number(entry.role.slice("participant-".length)));
    for (let index = 1; index <= highest; index += 1) {
      const role = `participant-${index}`;
      const file = walletPath(role, { walletRoot: root });
      let metadata;
      if (fs.existsSync(file)) {
        metadata = validateWalletMetadata(readJson(file), role);
        const validated = spawnWalletWorker("validate", JSON.stringify({ address: metadata.address, ciphertext: metadata.ciphertext }), { walletWorker });
        if (normalizeAddress(validated.address) !== metadata.address) throw new Error(`D17 wallet address mismatch for ${role}`);
      } else {
        if (entries.has(role)) throw new Error(`D17 wallet missing for existing ${role}; refusing rotation`);
        const created = spawnWalletWorker("create", "", { walletWorker });
        metadata = validateWalletMetadata({ ...created, role, schema: WALLET_SCHEMA, createdAt: now() }, role);
        if ([...entries.values()].some((item) => item.address.toLowerCase() === metadata.address.toLowerCase())) throw new Error("D17 generated wallet address duplicate");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (fs.existsSync(file)) throw new Error(`D17 wallet appeared concurrently for ${role}; refusing overwrite`);
        atomicWrite(file, `${JSON.stringify(metadata, null, 2)}\n`);
      }
      if (entries.has(role) && entries.get(role).address.toLowerCase() !== metadata.address.toLowerCase()) throw new Error(`D17 wallet address changed for ${role}; refusing rotation`);
      entries.set(role, { role, address: metadata.address });
    }
    const output = {
      schema: MANIFEST_SCHEMA,
      network: "sepolia",
      chainId: 11155111,
      createdAt: existingManifest?.createdAt || now(),
      updatedAt: now(),
      participants: [...entries.values()].sort((a, b) => a.role.localeCompare(b.role, undefined, { numeric: true })),
    };
    atomicWrite(manifestFile, `${JSON.stringify(output, null, 2)}\n`);
    return output;
  });
}

function parseEnvFile(file, expectedVariable) {
  let source;
  try { source = fs.readFileSync(file, "utf8"); } catch { throw new Error("D17 role env file cannot be read"); }
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equal = trimmed.indexOf("=");
    if (equal <= 0) throw new Error("D17 role env file syntax invalid");
    const key = trimmed.slice(0, equal).trim();
    let value = trimmed.slice(equal + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (values[key] !== undefined) throw new Error("D17 role env has duplicate variables");
    values[key] = value;
  }
  const sensitive = Object.keys(values).filter((key) => /(?:PRIVATE_KEY|MNEMONIC|SEED|SECRET|WALLET)/i.test(key) && key !== expectedVariable);
  if (sensitive.length || !Object.prototype.hasOwnProperty.call(values, expectedVariable)) throw new Error("D17 role env must contain exactly one expected signer secret");
  const key = values[expectedVariable];
  if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(key)) throw new Error("D17 role private key format invalid");
  return key.startsWith("0x") ? key : `0x${key}`;
}

function loadRolePrivateKey(role, repoRoot = REPO_ROOT) {
  const config = USER_ENV_FILES[role];
  if (!config) throw new Error(`D17 role ${role} has no user env file`);
  return parseEnvFile(path.join(repoRoot, config.file), config.variable);
}

function loadSignerForRole(role, repoRoot = REPO_ROOT, options = {}) {
  const { Wallet } = require("ethers");
  let privateKey;
  let expectedAddress;
  if (USER_ENV_FILES[role]) {
    privateKey = loadRolePrivateKey(role, repoRoot);
    const { profile } = loadPinnedPublic(repoRoot);
    expectedAddress = role === "deployer" ? profile.deployer : profile.authorizedNodes[Number(role.slice(-1)) - 1];
  } else if (PARTICIPANT_ROLE.test(role)) {
    const metadata = validateWalletMetadata(readJson(walletPath(role, options)), role);
    const manifestFile = manifestPath(repoRoot);
    if (!fs.existsSync(manifestFile)) throw new Error("D17 participant wallet manifest missing");
    const publicEntry = validateManifest(readJson(manifestFile)).participants.find((item) => item.role === role);
    if (!publicEntry || normalizeAddress(publicEntry.address) !== metadata.address) throw new Error(`D17 ${role} wallet does not match public manifest`);
    const result = spawnWalletWorker("decrypt", JSON.stringify({ address: metadata.address, ciphertext: metadata.ciphertext }), options);
    privateKey = result.privateKey;
    if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(privateKey || "")) throw new Error("D17 wallet child returned invalid signer");
    expectedAddress = metadata.address;
  } else {
    throw new Error("D17 role none cannot load a signer");
  }
  const address = new Wallet(privateKey).address;
  if (expectedAddress && normalizeAddress(address) !== normalizeAddress(expectedAddress)) throw new Error(`D17 ${role} signer does not match pinned public address`);
  return privateKey;
}

function participantAddresses(repoRoot = REPO_ROOT) {
  const file = manifestPath(repoRoot);
  if (!fs.existsSync(file)) return [];
  return validateManifest(readJson(file)).participants.map((item) => item.address);
}

function buildChildEnvironment({ stage, role, statePath, participants, execute, profile }) {
  assertStage(stage); assertRole(role);
  const env = {
    SystemRoot: process.env.SystemRoot,
    Path: process.env.Path || process.env.PATH,
    PATH: process.env.PATH || process.env.Path,
    ComSpec: process.env.ComSpec,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HARDHAT_NETWORK: "sepolia",
    HARDHAT_DISABLE_TELEMETRY_PROMPT: "true",
    SEPOLIA_RPC_URL: profile.publicRpcUrl,
    D17_STAGE: stage,
    D17_ROLE: role,
    D17_STATE_PATH: path.resolve(statePath),
    D17_PARTICIPANTS: participants.join(","),
  };
  if (execute) env.D17_EXECUTE = "1";
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

function runController(args, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const pinned = options.skipPublicValidation ? { profile: options.profile || { publicRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com" } } : loadPinnedPublic(repoRoot);
  const addresses = participantAddresses(repoRoot);
  const env = buildChildEnvironment({ stage: args.stage, role: args.role, statePath: args.statePath, participants: addresses.slice(0, args.participants), execute: args.execute, profile: pinned.profile });
  const result = (options.spawnSync || spawnSync)(process.execPath, ["--max-old-space-size=512", __filename, "--child"], {
    cwd: CONTRACTS_ROOT,
    env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const exit = result.status === null || result.status === undefined ? "signal" : String(result.status);
    throw new Error(`D17 role child failed (stage=${args.stage}, role=${args.role}, exit=${exit})`);
  }
  const output = redactOutput(String(result.stdout || "")).trim();
  return output;
}

async function runEngineChild() {
  const stage = process.env.D17_STAGE;
  const role = process.env.D17_ROLE || "none";
  assertStage(stage); assertRole(role);
  if (process.env.HARDHAT_NETWORK !== "sepolia") throw new Error("D17 child requires Sepolia network");
  const execute = process.env.D17_EXECUTE === "1";
  if (execute) process.env.D17_PRIVATE_KEY = loadSignerForRole(role, REPO_ROOT);
  else if (process.env.D17_PRIVATE_KEY) throw new Error("D17 read-only child cannot load a signer");
  process.argv = [process.execPath, ENGINE_PATH];
  require("ts-node/register/transpile-only");
  const engine = require(ENGINE_PATH);
  const entry = engine.main || engine.run || engine.runStage || engine.executeStage || engine.default;
  if (typeof entry !== "function") throw new Error("D17 engine must export main/run");
  const value = await entry();
  if (value !== undefined) process.stdout.write(redactOutput(typeof value === "string" ? value : JSON.stringify(value)));
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--child")) return runEngineChild();
  const args = parseArgs(argv);
  if (args.help) { console.log(helpText()); return; }
  if (args.initWallets) {
    const manifest = initWallets({ repoRoot: REPO_ROOT, participants: args.participants });
    console.log(JSON.stringify({ schema: manifest.schema, participants: manifest.participants }, null, 2));
    return;
  }
  const output = runController(args);
  if (output) process.stdout.write(`${output}\n`);
}

module.exports = {
  ALLOWED_ROLES,
  DEFAULT_STATE_PATH,
  MANIFEST_PATH,
  buildChildEnvironment,
  initWallets,
  loadPinnedPublic,
  loadSignerForRole,
  loadRolePrivateKey,
  main,
  manifestPath,
  parseArgs,
  parseEnvFile,
  participantAddresses,
  redactOutput,
  runController,
  walletPath,
  walletRoot,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${redactOutput(error && error.message ? error.message : "D17 launcher failed")}\n`);
    process.exitCode = 1;
  });
}
