/** E/19 sentetik Sepolia profili icin git-disi, izole deployer cuzdani olusturur. */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "ethers";

const ACK = "create-sepolia-e19-demo-wallet";
const walletPath = join(__dirname, "..", ".env.e19-demo");

if (process.env.E19_DEMO_WALLET_ACK !== ACK) {
  throw new Error(`E19 wallet: E19_DEMO_WALLET_ACK=${ACK} zorunlu`);
}
if (existsSync(walletPath)) throw new Error("E19 wallet: ayri E/19 deployer zaten var; yeni anahtar uretilmedi");

const wallet = Wallet.createRandom();
writeFileSync(walletPath, `DEPLOYER_PRIVATE_KEY=${wallet.privateKey}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ created: true, network: "sepolia", address: wallet.address, keyStoredLocally: true, keyLogged: false }, null, 2));
