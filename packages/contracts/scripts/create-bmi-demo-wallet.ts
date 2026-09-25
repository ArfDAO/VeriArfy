/** Teknofest BMI demosu icin Sepolia'ya ozel, git-disi test cüzdani olusturur. */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "ethers";

const ACK = "create-sepolia-bmi-demo-wallet";
const walletPath = join(__dirname, "..", ".env.bmi-demo");

function fail(message: string): never {
  throw new Error(`BMI demo wallet: ${message}`);
}

function main() {
  if (process.env.BMI_DEMO_WALLET_ACK !== ACK) {
    fail(`cüzdan olusturmak icin BMI_DEMO_WALLET_ACK=${ACK} zorunlu`);
  }
  if (existsSync(walletPath)) fail("ayri BMI demo cüzdani zaten mevcut; yeni anahtar uretilmedi");
  const wallet = Wallet.createRandom();
  // `dotenv` sadece BMI demo komutlarinda bu dosyayi yukler. Anahtar asla loglanmaz.
  writeFileSync(walletPath, `DEPLOYER_PRIVATE_KEY=${wallet.privateKey}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({
    created: true,
    network: "sepolia",
    address: wallet.address,
    keyStoredLocally: true,
    keyLogged: false,
  }, null, 2));
}

main();
