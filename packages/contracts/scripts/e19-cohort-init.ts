/** Create the private, synthetic 60-person E/19 cohort outside the repository. */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "ethers";

const ACK = "e19-synthetic-cohort";
const PROFILE = "e19-synthetic-cyp2c19-clopidogrel-v1";
const COUNT = 60;

type Participant = {
  index: number;
  group: 0 | 1;
  response: 0 | 1;
  address: string;
  privateKey: string;
};

function fail(message: string): never {
  throw new Error(`E19 cohort init: ${message}`);
}

function vaultPath(): string {
  const home = process.env.USERPROFILE;
  if (!home) fail("USERPROFILE bulunamadi; FarukOS kasasi yolu belirlenemiyor");
  return join(home, "FarukOS", "🔐 400-Vault", "VeriArfy", "e19-synthetic-cohort.json");
}

function main() {
  if (process.env.E19_COHORT_ACK !== ACK || process.env.E19_COHORT_INIT !== "1") {
    fail(`E19_COHORT_ACK=${ACK} ve E19_COHORT_INIT=1 olmadan anahtar uretilemez`);
  }
  const path = vaultPath();
  if (existsSync(path)) fail("cohort kasasi zaten var; asla uzerine yazilmaz");

  const participants: Participant[] = Array.from({ length: COUNT }, (_, index) => {
    const wallet = Wallet.createRandom();
    return {
      index,
      group: index < COUNT / 2 ? 0 : 1,
      response: index % (COUNT / 2) < COUNT / 4 ? 0 : 1,
      address: wallet.address,
      privateKey: wallet.privateKey,
    };
  });
  const directory = join(path, "..");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    schema: "veriarfy.e19.synthetic-cohort.v1",
    profile: PROFILE,
    syntheticOnly: true,
    createdAt: new Date().toISOString(),
    participants,
  }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows ACL is inherited from FarukOS vault. */ }
  console.log(JSON.stringify({ pass: true, profile: PROFILE, participantCount: participants.length, groups: [30, 30], cells: [15, 15, 15, 15], vault: "FarukOS/🔐 400-Vault/VeriArfy/e19-synthetic-cohort.json" }, null, 2));
}

main();
