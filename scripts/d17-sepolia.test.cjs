"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const launcher = require("./d17-sepolia.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "veriarfy-d17-launcher-"));
}

function address(index) {
  return `0x${index.toString(16).padStart(40, "0")}`;
}

test("CLI accepts generic engine stages but rejects invalid roles", () => {
  assert.equal(launcher.parseArgs(["--stage", "settle-query", "--role", "participant-5"]).role, "participant-5");
  assert.throws(() => launcher.parseArgs(["--stage", "settle_query"]), /stage is invalid/);
  assert.throws(() => launcher.parseArgs(["--stage", "preflight", "--role", "node-3"]), /role is invalid/);
  assert.match(launcher.parseArgs(["--help"]).role, /none/);
  assert.throws(() => launcher.parseArgs(["--wallet-worker", "decrypt"]), /unknown D17 option/);
});

test("public launcher cannot expose the internal wallet worker", async () => {
  await assert.rejects(() => launcher.main(["--wallet-worker", "decrypt"]), /unknown D17 option/);
});

test("role env parser allows only the expected signer variable", () => {
  const root = tempDir();
  const good = path.join(root, "good.env");
  fs.writeFileSync(good, `DEPLOYER_PRIVATE_KEY=${"11".repeat(32)}\nPUBLIC_LABEL=test\n`);
  assert.equal(launcher.parseEnvFile(good, "DEPLOYER_PRIVATE_KEY"), `0x${"11".repeat(32)}`);

  const mixed = path.join(root, "mixed.env");
  fs.writeFileSync(mixed, `DEPLOYER_PRIVATE_KEY=${"11".repeat(32)}\nNODE_PRIVATE_KEY=${"22".repeat(32)}\n`);
  assert.throws(() => launcher.parseEnvFile(mixed, "DEPLOYER_PRIVATE_KEY"), /exactly one expected signer/);
});

test("pinned signer mismatch fails without echoing the key", () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, "packages", "contracts", "ops"), { recursive: true });
  fs.mkdirSync(path.join(root, "packages", "contracts", "deployments"), { recursive: true });
  fs.writeFileSync(path.join(root, ".env.d17.deployer"), `DEPLOYER_PRIVATE_KEY=${"11".repeat(32)}\n`);
  const profile = {
    network: "sepolia", chainId: 11155111, publicRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    deployer: address(99), authorizedNodes: [address(98), address(97)],
  };
  const deployment = {
    network: "sepolia", chainId: 11155111, deployer: address(99), authorizedNodes: profile.authorizedNodes,
    contracts: { VeriarfyProtocol: address(1), VeriarfyPayments: address(2), VeriarfyStaking: address(3), PaymentToken: address(4) },
  };
  fs.writeFileSync(path.join(root, "packages", "contracts", "ops", "d15-sepolia.json"), JSON.stringify(profile));
  fs.writeFileSync(path.join(root, "packages", "contracts", "deployments", "sepolia.json"), JSON.stringify(deployment));
  assert.throws(() => launcher.loadSignerForRole("deployer", root), (error) => {
    return !String(error).includes("11".repeat(32)) && String(error).includes("does not match");
  });
});

test("wallet initialization is resumable and never rotates an existing wallet", () => {
  const root = tempDir();
  const wallets = path.join(root, "localappdata", "wallets");
  let creates = 0;
  const worker = (mode, input) => {
    if (mode === "create") {
      creates += 1;
      return { address: address(creates), ciphertext: `ciphertext-${creates}` };
    }
    const parsed = JSON.parse(input);
    return { address: parsed.address };
  };

  const first = launcher.initWallets({ repoRoot: root, walletRoot: wallets, participants: 3, walletWorker: worker, now: () => "2026-09-10T00:00:00.000Z" });
  assert.equal(first.participants.length, 3);
  const firstWallet = fs.readFileSync(path.join(wallets, "participant-1.json"), "utf8");
  assert.throws(() => launcher.initWallets({ repoRoot: root, walletRoot: wallets, participants: 3, walletWorker: () => ({ address: address(1), privateKey: "should-not-cross-boundary" }) }), /private material/);
  fs.writeFileSync(path.join(wallets, ".d17-init.lock"), "competing-process\n");
  assert.throws(() => launcher.initWallets({ repoRoot: root, walletRoot: wallets, participants: 3, walletWorker: worker }), /already running/);
  fs.unlinkSync(path.join(wallets, ".d17-init.lock"));
  const second = launcher.initWallets({ repoRoot: root, walletRoot: wallets, participants: 3, walletWorker: worker, now: () => "2026-09-11T00:00:00.000Z" });
  assert.equal(creates, 3);
  assert.equal(fs.readFileSync(path.join(wallets, "participant-1.json"), "utf8"), firstWallet);
  assert.deepEqual(second.participants.map((item) => item.address), first.participants.map((item) => item.address));
  const five = launcher.initWallets({ repoRoot: root, walletRoot: wallets, participants: 5, walletWorker: worker, now: () => "2026-09-12T00:00:00.000Z" });
  assert.equal(creates, 5);
  assert.equal(five.participants.length, 5);
});

test("read-only controller has no signer key and uses a strict allowlist", () => {
  const root = tempDir();
  let childEnv;
  const output = launcher.runController({
    stage: "preflight", role: "none", execute: false, participants: 3,
    statePath: path.join(root, "d17-live.json"),
  }, {
    repoRoot: root,
    skipPublicValidation: true,
    spawnSync: (_file, _args, options) => { childEnv = options.env; return { status: 0, stdout: "preflight ok", stderr: "" }; },
  });
  assert.equal(output, "preflight ok");
  assert.equal(childEnv.D17_PRIVATE_KEY, undefined);
  assert.equal(childEnv.D17_EXECUTE, undefined);
  assert.equal(childEnv.HARDHAT_NETWORK, "sepolia");
  assert.equal(childEnv.D17_ROLE, "none");
  assert.equal(childEnv.D17_STAGE, "preflight");
  assert.equal(Object.keys(childEnv).some((key) => /PRIVATE_KEY|MNEMONIC|SEED|D15_|LIVE_CHECK_/.test(key)), false);
});

test("child failure output is redacted before it reaches the operator", () => {
  const secret = `0x${"ab".repeat(32)}`;
  assert.doesNotMatch(launcher.redactOutput(`{"privateKey":"${secret}","signedTransaction":"0xdeadbeef"}`), new RegExp(secret));
  assert.throws(() => launcher.runController({
    stage: "contribute", role: "none", execute: false, participants: 3, statePath: "C:\\temp\\d17.json",
  }, {
    repoRoot: tempDir(), skipPublicValidation: true,
    spawnSync: () => ({ status: 1, stdout: "", stderr: `{"privateKey":"${secret}"}` }),
  }), (error) => !String(error).includes(secret) && String(error).includes("stage=contribute") && String(error).includes("role=none"));
});
