import { join } from "node:path";

import dotenv from "dotenv";
import "@nomicfoundation/hardhat-toolbox";

import type { HardhatUserConfig } from "hardhat/config";

/**
 * Filecoin Calibration icin AYRI hardhat yapilandirmasi (rapor §2.9.2).
 *
 * # Neden ayri dosya
 *
 * `@fhevm/hardhat-plugin` yalnizca hardhat / localhost / anvil / sepolia /
 * mainnet aglarini taniyor; baska bir ag adi gorunce eklenti seviyesinde
 * hata veriyor. Bu yuzden Filecoin islerinde eklenti HIC yuklenmez.
 *
 * Kayip bir sey yok: Filecoin tarafinda FHE islemi yapilmaz, yalnizca
 * depolama anlasmasi kurulur.
 *
 * # Kullanim
 *
 *   npx hardhat --config hardhat.filecoin.ts run scripts/<betik>.ts --network calibration
 *
 * # Ayni anahtar
 *
 * FVM Ethereum JSON-RPC'yi destekler; Sepolia'da kullanilan ozel anahtar
 * burada da gecerlidir ve adres 0x bicimini korur. Yeni cuzdan gerekmez.
 */
dotenv.config();
dotenv.config({ path: join(__dirname, "..", "..", ".env") });

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? "";

const config: HardhatUserConfig = {
  solidity: {
    /**
     * 0.8.17 — SECIM DEGIL, ZORUNLULUK.
     *
     * `@zondax/solidity-bignumber` KESIN pragma kullanir (`pragma solidity
     * 0.8.17;`, karet yok). DealClient de o zincire bagimli oldugu icin tum
     * Filecoin tarafi bu surumde derlenir.
     *
     * `evmVersion: london` da bundan turer: `paris` solc 0.8.18 ile geldi,
     * 0.8.17 onu tanimaz. Zaten Filecoin FVM daha yeni opcode'lari
     * desteklemez, yani kisit iki yonden de ayni yere cikiyor.
     *
     * Ana yapilandirma (Sepolia + FHE) bundan ETKILENMEZ: ayri dosya, ayri
     * kaynak agaci, ayri cikti klasoru.
     */
    version: "0.8.17",
    settings: {
      optimizer: {
        enabled: true,
        runs: 800,
        /**
         * Yul optimizer KAPALI — referans projenin `foundry.toml`'u da
         * (`yul = false`) boyle yapiyor.
         *
         * Sebep derleyicinin kendi hatasinda yaziyor: `BigNumbers.sol`
         * icindeki assembly `msize` kullanir ve Yul optimizer bu komutun
         * anlamini degistirebilecegi icin ikisi birlikte reddedilir.
         */
        details: { yul: false },
      },
      evmVersion: "london",
    },
  },
  networks: {
    calibration: {
      url: process.env.FILECOIN_RPC_URL ?? "https://api.calibration.node.glif.io/rpc/v1",
      chainId: 314159,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  paths: {
    /**
     * Kaynaklar da ciktilar da ana yapilandirmadan AYRIDIR.
     *
     * Kaynak ayrimi: `filecoin/contracts/` icindeki DealClient, Protocol
     * Labs'tan alinma referans koddur ve `@zondax/filecoin-solidity`'ye
     * bagimlidir. Ana `contracts/` agacinda dursaydi Sepolia derlemesi de onu
     * derlemeye calisir ve FHE tarafi bu bagimlilik yuzunden kirilirdi.
     *
     * Cikti ayrimi: iki yapilandirma farkli `evmVersion` kullanir (cancun vs
     * paris); ayni klasoru paylasirlarsa artifact'lar birbirini ezer.
     */
    sources: "filecoin/contracts",
    artifacts: "filecoin/artifacts",
    cache: "filecoin/cache",
  },
};

export default config;
