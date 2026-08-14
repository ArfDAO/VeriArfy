import { join } from "node:path";

import dotenv from "dotenv";
import "@nomicfoundation/hardhat-toolbox";
import "@fhevm/hardhat-plugin";

import type { HardhatUserConfig } from "hardhat/config";

// Depoda TEK bir .env vardir ve kokte durur (bkz. kokteki .env.example).
// `dotenv/config` ise calisma dizinine bakar; npm workspace komutlari bu
// dosyayi packages/contracts icinden calistirdigi icin kokteki .env sessizce
// bulunamaz ve `accounts` bos kalir — deploy "no signer" ile duser.
// Once yerel, sonra kok: yerel bir .env varsa o kazanir.
dotenv.config();
dotenv.config({ path: join(__dirname, "..", "..", ".env") });

const SEPOLIA_RPC_URL =
  process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 800 },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      // FHEVM mock ortami plugin tarafindan otomatik saglanir.
      // Calisma dogrulamasi her katilimci icin ayri bir cuzdan kullanir.
      accounts: { count: 64 },
    },
    sepolia: {
      url: SEPOLIA_RPC_URL,
      chainId: 11155111,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY ?? "",
  },
};

export default config;
