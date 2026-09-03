import { join } from "node:path";

import dotenv from "dotenv";
import "@nomicfoundation/hardhat-toolbox";
import "@fhevm/hardhat-plugin";

import type { HardhatUserConfig } from "hardhat/config";
import { parseLiveCheckStage } from "./scripts/live-check-state";

// Live-check signer'lari shared `.env` dosyasindan okunmaz. Stage ve tek signer
// key'i operatorun ayri proses environment'inda explicit verilmelidir; boylece
// node prosesi deployer key'ini dotenv ile kisa sureligine bile yuklemez.
const isLiveCheckInvocation = process.argv.some((arg) =>
  /(?:^|[\\/])live-check\.(?:ts|js)$/.test(arg),
);
const requestedLiveCheckStage = process.env.LIVE_CHECK_STAGE?.trim();
if (requestedLiveCheckStage && !isLiveCheckInvocation) {
  throw new Error(
    "LIVE_CHECK_STAGE yalniz scripts/live-check.ts invocation'inda kullanilabilir; " +
      "deploy/preflight oncesi stage environment'ini temizleyin",
  );
}
const isLiveCheckConfigured = isLiveCheckInvocation;

// Depoda TEK bir .env vardir ve kokte durur (bkz. kokteki .env.example).
// `dotenv/config` ise calisma dizinine bakar; npm workspace komutlari bu
// dosyayi packages/contracts icinden calistirdigi icin kokteki .env sessizce
// bulunamaz ve `accounts` bos kalir — deploy "no signer" ile duser.
// Once yerel, sonra kok: yerel bir .env varsa o kazanir.
if (!isLiveCheckConfigured) {
  dotenv.config();
  dotenv.config({ path: join(__dirname, "..", "..", ".env") });
}

const SEPOLIA_RPC_URL =
  process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? "";
const NODE_PRIVATE_KEY = process.env.NODE_PRIVATE_KEY ?? "";

// Hardhat loads this file before it evaluates the script. Keep ordinary
// compile/test/deploy commands backwards compatible, but make a live-check
// invocation fail closed when its stage or signer environment is incomplete.
let liveCheckPrivateKey = DEPLOYER_PRIVATE_KEY;

if (isLiveCheckConfigured) {
  const stage = parseLiveCheckStage(requestedLiveCheckStage);
  const nodeStage = stage === "node-1" || stage === "node-2";
  const expectedKey = nodeStage ? NODE_PRIVATE_KEY : DEPLOYER_PRIVATE_KEY;
  const forbiddenKey = nodeStage ? DEPLOYER_PRIVATE_KEY : NODE_PRIVATE_KEY;

  if (!expectedKey) {
    throw new Error(
      `${stage}: ${nodeStage ? "NODE_PRIVATE_KEY" : "DEPLOYER_PRIVATE_KEY"} zorunludur`,
    );
  }
  if (forbiddenKey) {
    throw new Error(
      `${stage}: signer isolation ihlali; diger private key ayni proseste gorunuyor`,
    );
  }

  liveCheckPrivateKey = expectedKey;
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      // `runs` DUSUK BILEREK SECILDI.
      //
      // 800'de `VeriarfyProtocol` EIP-170'in 24.576 baytlik sinirina 63 bayt
      // kala dayandi. Optimizasyon "runs" degeri, derleyiciye kodun kac kez
      // CALISTIRILACAGINI soyler: yuksek deger calisma gazini ucuzlatir ama
      // kodu buyutur.
      //
      // Bu projede takas nettir: islem maliyetine HOMOMORFIK ISLEMLER hakim
      // (SNP basina ~673.000 gaz). Cagri dagitimindaki birkac yuz gazlik fark
      // olculebilir bile degil; kod boyutu ise dagitilabilirligin ta kendisi.
      //
      // Olculen: 800 -> 24.513 · 400 -> 24.300 · 200 -> 24.074 · 100 -> 23.587
      optimizer: { enabled: true, runs: 100 },
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
      accounts: liveCheckPrivateKey ? [liveCheckPrivateKey] : [],
    },
    // Filecoin Calibration AYRI bir yapilandirmadadir: `hardhat.filecoin.ts`.
    // Sebep: `@fhevm/hardhat-plugin` yalnizca hardhat/localhost/anvil/sepolia/
    // mainnet aglarini kabul eder ve baska bir ag adi gorunce eklenti
    // seviyesinde hata verir. Ayni dosyada tutmak mumkun degil.
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY ?? "",
  },
};

export default config;
