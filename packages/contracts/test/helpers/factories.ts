import { ethers } from "hardhat";

/**
 * Kutuphane BAGLAMA yardimcisi.
 *
 * `VeriarfyProtocol` ve `VeriarfyBiomarkers`, EIP-170'in 24.576 baytlik kod
 * sinirini asmamak icin agir homomorfik dongulerini `public` kutuphanelere
 * tasir. `public` kutuphane fonksiyonlari ayri bir adrese dagitilir ve
 * `delegatecall` ile cagrilir; bu yuzden fabrika olusturulurken adreslerin
 * BAGLANMASI gerekir. Baglanmazsa dagitim "missing links" hatasiyla duser.
 *
 * Testlerin her biri bunu kendi icinde tekrar etmesin diye tek yerde durur.
 */

/** Kontenjans tablosu kutuphanesi baglanmis protokol fabrikasi. */
export async function protocolFactory() {
  const Contingency = await ethers.getContractFactory("ContingencyStats");
  const contingency = await Contingency.deploy();
  await contingency.waitForDeployment();

  const Coverage = await ethers.getContractFactory("CoverageBits");
  const coverage = await Coverage.deploy();
  await coverage.waitForDeployment();

  return ethers.getContractFactory("VeriarfyProtocol", {
    libraries: {
      ContingencyStats: await contingency.getAddress(),
      CoverageBits: await coverage.getAddress(),
    },
  });
}

/**
 * "Hepsi kapsandi" maskesi.
 *
 * @remarks Kapsama bitmap'i odemeyi belirler; testlerin cogu kapsama
 *          davranisini degil istatistigi olcuyor, bu yuzden varsayilan
 *          "her alanda gercek veri var"dir. Kapsamayi ozellikle sinayan
 *          testler kendi maskesini verir.
 */
export function fullCoverage(count: number): bigint {
  return (1n << BigInt(count)) - 1n;
}

/** Biyobelirtec istatistik kutuphanesi baglanmis modul fabrikasi. */
export async function biomarkersFactory() {
  const Stats = await ethers.getContractFactory("BiomarkerStats");
  const stats = await Stats.deploy();
  await stats.waitForDeployment();

  const Coverage = await ethers.getContractFactory("CoverageBits");
  const coverage = await Coverage.deploy();
  await coverage.waitForDeployment();

  return ethers.getContractFactory("VeriarfyBiomarkers", {
    libraries: {
      BiomarkerStats: await stats.getAddress(),
      CoverageBits: await coverage.getAddress(),
    },
  });
}
