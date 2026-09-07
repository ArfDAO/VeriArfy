import { join } from "node:path";

import dotenv from "dotenv";
import "@nomicfoundation/hardhat-toolbox";
import "@fhevm/hardhat-plugin";

import type { HardhatUserConfig } from "hardhat/config";
import {
  D15_PROFILE_ID,
  loadD15Profile,
  parseD15NodeRole,
} from "./scripts/d15-profile";
import { parseLiveCheckStage } from "./scripts/live-check-state";

function invokesScript(name: string): boolean {
  return process.argv.some((arg) =>
    new RegExp(`(?:^|[\\\\/])${name}\\.(?:ts|js)$`).test(arg),
  );
}

// D15 signer'lari shared `.env` dosyasindan okunmaz. Stage ve tek signer key'i
// operatorun ayri proses environment'inda explicit verilmelidir; boylece bir
// node prosesi deployer key'ini dotenv ile kisa sureligine bile yuklemez.
const isLiveCheckInvocation = invokesScript("live-check");
const isD15ReadinessInvocation = invokesScript("d15-readiness");
const isStakeNodeInvocation = invokesScript("stake-node");
const isDeployInvocation = invokesScript("deploy");
const isD15ResumeInvocation = invokesScript("d15-resume");
const isPreflightInvocation = invokesScript("preflight");
const isProofCheckInvocation = invokesScript("proof-check");
const isRedeployInvocation = invokesScript("d15-redeploy");
const isRedeployPlanInvocation = invokesScript("d15-redeploy-plan-write");
const requestedLiveCheckStage = process.env.LIVE_CHECK_STAGE?.trim();
if (requestedLiveCheckStage && !isLiveCheckInvocation) {
  throw new Error(
    "LIVE_CHECK_STAGE yalniz scripts/live-check.ts invocation'inda kullanilabilir; " +
      "deploy/preflight oncesi stage environment'ini temizleyin",
  );
}
const isLiveCheckConfigured = isLiveCheckInvocation;
const requestedD15Profile = process.env.D15_PROFILE?.trim();
if (requestedD15Profile && requestedD15Profile !== D15_PROFILE_ID) {
  throw new Error(`bilinmeyen D15_PROFILE: ${requestedD15Profile}`);
}
const isD15Profile = requestedD15Profile === D15_PROFILE_ID;
const isAllowedD15Invocation =
  isD15ReadinessInvocation ||
  isStakeNodeInvocation ||
  isDeployInvocation ||
  isD15ResumeInvocation ||
  isPreflightInvocation ||
  isProofCheckInvocation ||
  isRedeployInvocation ||
  isRedeployPlanInvocation ||
  isLiveCheckInvocation;
if (isD15Profile && !isAllowedD15Invocation) {
  throw new Error("D15_PROFILE yalniz readiness/preflight/proof-check/deploy/resume/redeploy/stake/live-check icindir");
}
if ((isD15ReadinessInvocation || isStakeNodeInvocation) && !isD15Profile) {
  throw new Error(`${isStakeNodeInvocation ? "stake-node" : "d15-readiness"}: D15_PROFILE zorunludur`);
}
if (isD15ResumeInvocation && !isD15Profile) {
  throw new Error("resume: D15_PROFILE zorunludur");
}
if (isProofCheckInvocation && !isD15Profile) {
  throw new Error("proof-check: D15_PROFILE zorunludur");
}
if ((isRedeployInvocation || isRedeployPlanInvocation) && !isD15Profile) {
  throw new Error("redeploy: D15_PROFILE zorunludur");
}

const executionAck = process.env.D15_EXECUTION_ACK?.trim();
if (executionAck && !isD15Profile) {
  throw new Error("D15_EXECUTION_ACK yalniz onayli D15 profile ile kullanilabilir");
}

// Depoda TEK bir .env vardir ve kokte durur (bkz. kokteki .env.example).
// `dotenv/config` ise calisma dizinine bakar; npm workspace komutlari bu
// dosyayi packages/contracts icinden calistirdigi icin kokteki .env sessizce
// bulunamaz ve `accounts` bos kalir — deploy "no signer" ile duser.
// Once yerel, sonra kok: yerel bir .env varsa o kazanir.
if (!isLiveCheckConfigured && !isD15Profile) {
  dotenv.config();
  dotenv.config({ path: join(__dirname, "..", "..", ".env") });
}

const SEPOLIA_RPC_URL =
  process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
if (isD15Profile) {
  const approvedProfile = loadD15Profile();
  let runtimeRpcUrl: string;
  try {
    runtimeRpcUrl = new URL(SEPOLIA_RPC_URL).toString();
  } catch {
    throw new Error("D15 SEPOLIA_RPC_URL gecersiz");
  }
  if (runtimeRpcUrl !== approvedProfile.publicRpcUrl) {
    throw new Error("D15 SEPOLIA_RPC_URL onayli public profile ile eslesmiyor");
  }
}
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? "";
const NODE_PRIVATE_KEY = process.env.NODE_PRIVATE_KEY ?? "";

// Hardhat loads this file before it evaluates the script. Ordinary commands
// remain backwards compatible; the D15 profile fails closed on script, role,
// acknowledgement and single-signer isolation before a script can run.
let sepoliaPrivateKey = DEPLOYER_PRIVATE_KEY;

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
  if (isD15Profile && executionAck !== stage) {
    throw new Error(`${stage}: D15_EXECUTION_ACK '${stage}' olmalidir`);
  }

  sepoliaPrivateKey = expectedKey;
} else if (isD15Profile) {
  if (isD15ReadinessInvocation || isPreflightInvocation || isProofCheckInvocation || isRedeployPlanInvocation) {
    if (DEPLOYER_PRIVATE_KEY || NODE_PRIVATE_KEY || executionAck) {
      throw new Error(
        `${isRedeployPlanInvocation ? "redeploy-plan" : isProofCheckInvocation ? "proof-check" : isPreflightInvocation ? "preflight" : "readiness"} ` +
          "signer/ack kabul etmez; salt-okunur calismalidir",
      );
    }
    sepoliaPrivateKey = "";
  } else if (isRedeployInvocation) {
    if (executionAck && executionAck !== "redeploy") throw new Error("redeploy: D15_EXECUTION_ACK 'redeploy' olmalidir");
    if (executionAck) {
      if (!DEPLOYER_PRIVATE_KEY || NODE_PRIVATE_KEY) throw new Error("redeploy: yalniz DEPLOYER_PRIVATE_KEY verilmelidir");
      sepoliaPrivateKey = DEPLOYER_PRIVATE_KEY;
    } else {
      if (DEPLOYER_PRIVATE_KEY || NODE_PRIVATE_KEY) throw new Error("redeploy check signer kabul etmez");
      sepoliaPrivateKey = "";
    }
  } else if (isD15ResumeInvocation) {
    if (executionAck && executionAck !== "resume") {
      throw new Error("resume: D15_EXECUTION_ACK 'resume' olmalidir");
    }
    if (executionAck) {
      if (!DEPLOYER_PRIVATE_KEY || NODE_PRIVATE_KEY) {
        throw new Error("resume: yalniz DEPLOYER_PRIVATE_KEY verilmelidir");
      }
      sepoliaPrivateKey = DEPLOYER_PRIVATE_KEY;
    } else {
      if (DEPLOYER_PRIVATE_KEY || NODE_PRIVATE_KEY) {
        throw new Error("resume check signer kabul etmez");
      }
      sepoliaPrivateKey = "";
    }
  } else if (isStakeNodeInvocation) {
    const role = parseD15NodeRole(process.env.D15_NODE_ROLE);
    const expectedAck = `stake-${role}`;
    if (executionAck && executionAck !== expectedAck) {
      throw new Error(`${role}: D15_EXECUTION_ACK '${expectedAck}' olmalidir`);
    }
    if (executionAck) {
      if (!NODE_PRIVATE_KEY || DEPLOYER_PRIVATE_KEY) {
        throw new Error(`${role}: yalniz NODE_PRIVATE_KEY verilmelidir`);
      }
      sepoliaPrivateKey = NODE_PRIVATE_KEY;
    } else {
      if (NODE_PRIVATE_KEY || DEPLOYER_PRIVATE_KEY) {
        throw new Error(`${role} dry-run signer kabul etmez`);
      }
      sepoliaPrivateKey = "";
    }
  } else {
    if (!DEPLOYER_PRIVATE_KEY || NODE_PRIVATE_KEY) {
      throw new Error("D15 deployer islemi yalniz DEPLOYER_PRIVATE_KEY kullanmalidir");
    }
    if (isDeployInvocation && executionAck !== "deploy") {
      throw new Error("deploy: D15_EXECUTION_ACK 'deploy' olmalidir");
    }
    sepoliaPrivateKey = DEPLOYER_PRIVATE_KEY;
  }
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
      accounts: sepoliaPrivateKey ? [sepoliaPrivateKey] : [],
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
