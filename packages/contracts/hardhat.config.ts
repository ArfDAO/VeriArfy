import "dotenv/config";
import "@nomicfoundation/hardhat-toolbox";
import "@fhevm/hardhat-plugin";

import type { HardhatUserConfig } from "hardhat/config";

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
