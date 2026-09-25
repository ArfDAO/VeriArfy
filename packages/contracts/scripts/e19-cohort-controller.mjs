/**
 * Supervises short-lived FHE CLI workers until all 60 E/19 synthetic rows are
 * on-chain. Each child is idempotent; progress is re-read from Sepolia before
 * it is restarted, so a client-side process exit cannot duplicate a record.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Contract, JsonRpcProvider, isAddress } from "ethers";

const ACK = "e19-synthetic-cohort";
const PROFILE = "e19-synthetic-cyp2c19-clopidogrel-v1";
const directory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = join(directory, "..");
const hardhatCli = join(packageDirectory, "..", "..", "node_modules", "hardhat", "internal", "cli", "cli.js");
const protocolAddress = "0xC6128143BA5bcB8D2aE89494581BD6fc44f6Cc08";
const aggregateAddress = "0x7C389Fe92F1FE199586b7bF9DD939A5B28F4C7C3";
const protocolAbi = ["function participantCount() view returns (uint32)", "function isEnrolled(address) view returns (bool)"];
const aggregateAbi = ["function contributed(address) view returns (bool)"];

function fail(message) { throw new Error(`E19 cohort controller: ${message}`); }

function rows() {
  if (process.env.E19_COHORT_ACK !== ACK || process.env.E19_COHORT_CONTROLLER !== "1") {
    fail(`E19_COHORT_ACK=${ACK} and E19_COHORT_CONTROLLER=1 are required`);
  }
  const home = process.env.USERPROFILE;
  if (!home) fail("USERPROFILE missing; FarukOS vault cannot be resolved");
  const vault = JSON.parse(readFileSync(join(home, "FarukOS", "🔐 400-Vault", "VeriArfy", "e19-synthetic-cohort.json"), "utf8"));
  if (vault.schema !== "veriarfy.e19.synthetic-cohort.v1" || vault.profile !== PROFILE || vault.syntheticOnly !== true || !Array.isArray(vault.participants) || vault.participants.length !== 60 || vault.participants.some((row, index) => row.index !== index || !isAddress(row.address))) {
    fail("FarukOS cohort vault is invalid");
  }
  return vault.participants;
}

async function state(provider, participants) {
  const protocol = new Contract(protocolAddress, protocolAbi, provider);
  const aggregate = new Contract(aggregateAddress, aggregateAbi, provider);
  const values = await Promise.all(participants.map(async (row) => ({
    enrolled: await protocol.isEnrolled(row.address),
    contributed: await aggregate.contributed(row.address),
  })));
  return {
    participantCount: Number(await protocol.participantCount()),
    enrolled: values.filter((value) => value.enrolled).length,
    contributed: values.filter((value) => value.contributed).length,
    next: values.findIndex((value) => !value.contributed),
  };
}

async function main() {
  const participants = rows();
  const provider = new JsonRpcProvider(process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com");
  let consecutiveNoProgress = 0;
  for (;;) {
    const before = await state(provider, participants);
    if (before.next === -1) {
      if (before.participantCount !== 60 || before.enrolled !== 60 || before.contributed !== 60) fail("final E19 cohort counters disagree");
      console.log(JSON.stringify({ pass: true, ...before }));
      return;
    }
    const [latestNonce, pendingNonce] = await Promise.all([
      provider.getTransactionCount(participants[before.next].address, "latest"),
      provider.getTransactionCount(participants[before.next].address, "pending"),
    ]);
    if (pendingNonce > latestNonce) {
      console.log(JSON.stringify({ waitingForPendingNonce: before.next, latestNonce, pendingNonce }));
      await new Promise((resolve) => setTimeout(resolve, 15000));
      continue;
    }
    const end = Math.min(before.next + 2, 59);
    const result = spawnSync(
      process.execPath,
      [hardhatCli, "run", "--no-compile", "scripts/e19-cohort-batch.ts", "--network", "sepolia"],
      {
        cwd: packageDirectory,
        env: { ...process.env, E19_COHORT_ACK: ACK, E19_COHORT_BATCH: "1", E19_BATCH_START: String(before.next), E19_BATCH_END: String(end) },
        encoding: "utf8",
        windowsHide: true,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const after = await state(provider, participants);
    console.log(JSON.stringify({ before, after, attemptedRange: [before.next, end], childStatus: result.status }));
    if (after.enrolled <= before.enrolled && after.contributed <= before.contributed) {
      consecutiveNoProgress += 1;
      if (consecutiveNoProgress > 5) fail("FHE child repeated without verified on-chain progress");
      await new Promise((resolve) => setTimeout(resolve, 15000));
      continue;
    }
    consecutiveNoProgress = 0;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
