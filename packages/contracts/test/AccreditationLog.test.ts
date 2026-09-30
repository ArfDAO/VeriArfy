import { expect } from "chai";
import { ethers } from "hardhat";

describe("AccreditationLog", () => {
  const key = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
  const ORCID_SELF = 2;
  const MANUAL = 1;

  async function deploy() {
    const [curator, stranger] = await ethers.getSigners();
    const log = await (await ethers.getContractFactory("AccreditationLog")).deploy(curator.address);
    return { log, curator, stranger };
  }

  it("dogrulanmis taahhudu listeye ekler ve sirasiyla okur", async () => {
    const { log } = await deploy();
    await log.accredit(11n, key("a@erciyes.edu.tr"), key("0000-0001"), ORCID_SELF);
    await log.accredit(22n, key("b@erciyes.edu.tr"), ethers.ZeroHash, MANUAL);
    expect(await log.commitmentCount()).to.equal(2n);
    expect(await log.commitmentsFrom(0, 10)).to.deep.equal([11n, 22n]);
    expect(await log.commitmentsFrom(1, 10)).to.deep.equal([22n]);
    expect(await log.commitmentsFrom(5, 10)).to.deep.equal([]);
  });

  it("ayni e-posta ikinci kimlik acamaz", async () => {
    const { log } = await deploy();
    await log.accredit(11n, key("a@erciyes.edu.tr"), ethers.ZeroHash, MANUAL);
    await expect(log.accredit(12n, key("a@erciyes.edu.tr"), ethers.ZeroHash, MANUAL))
      .to.be.revertedWithCustomError(log, "IdentityAlreadyUsed");
  });

  it("ayni ORCID farkli e-postayla ikinci kimlik acamaz", async () => {
    const { log } = await deploy();
    await log.accredit(11n, key("a@erciyes.edu.tr"), key("0000-0001"), ORCID_SELF);
    await expect(log.accredit(12n, key("alias@erciyes.edu.tr"), key("0000-0001"), ORCID_SELF))
      .to.be.revertedWithCustomError(log, "IdentityAlreadyUsed");
  });

  it("basarisiz denemede hicbir ozet harcanmaz", async () => {
    const { log } = await deploy();
    await log.accredit(11n, key("a@x.edu.tr"), key("orcid-1"), ORCID_SELF);
    // profil kullanilmis: islem geri alinir, yeni e-posta HARCANMAMIS kalmali
    await expect(log.accredit(12n, key("b@x.edu.tr"), key("orcid-1"), ORCID_SELF)).to.be.reverted;
    expect(await log.identityUsed(key("b@x.edu.tr"))).to.equal(false);
  });

  it("ayni taahhut iki kez listelenemez", async () => {
    const { log } = await deploy();
    await log.accredit(11n, key("a@x.edu.tr"), ethers.ZeroHash, MANUAL);
    await expect(log.accredit(11n, key("b@x.edu.tr"), ethers.ZeroHash, MANUAL))
      .to.be.revertedWithCustomError(log, "CommitmentAlreadyListed");
  });

  it("gecersiz girdileri reddeder", async () => {
    const { log } = await deploy();
    const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    await expect(log.accredit(0n, key("a"), ethers.ZeroHash, MANUAL)).to.be.revertedWithCustomError(log, "InvalidCommitment");
    await expect(log.accredit(FIELD, key("a"), ethers.ZeroHash, MANUAL)).to.be.revertedWithCustomError(log, "InvalidCommitment");
    await expect(log.accredit(1n, ethers.ZeroHash, ethers.ZeroHash, MANUAL)).to.be.revertedWithCustomError(log, "InvalidIdentityKey");
    await expect(log.accredit(1n, key("a"), key("a"), MANUAL)).to.be.revertedWithCustomError(log, "InvalidIdentityKey");
    await expect(log.accredit(1n, key("a"), ethers.ZeroHash, 0)).to.be.revertedWithCustomError(log, "InvalidEvidence");
    await expect(log.accredit(1n, key("a"), ethers.ZeroHash, 4)).to.be.revertedWithCustomError(log, "InvalidEvidence");
  });

  it("yalnizca kurator ekleyebilir", async () => {
    const { log, stranger } = await deploy();
    await expect(log.connect(stranger).accredit(11n, key("a"), ethers.ZeroHash, MANUAL))
      .to.be.revertedWithCustomError(log, "OwnableUnauthorizedAccount");
  });
});
