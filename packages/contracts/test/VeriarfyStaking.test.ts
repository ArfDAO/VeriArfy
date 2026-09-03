import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import type { Signer } from "ethers";
import { protocolFactory } from "./helpers/factories";

/**
 * Kripto-ekonomik guvenlik — rapor §2.7.
 *
 * Testlerin yanitladigi sorular:
 *
 *   - Teminatsiz bir dugum onay verebiliyor mu?           (verememeli)
 *   - Itiraz suresi dolmadan acilim yurutulebiliyor mu?   (yurutulememeli)
 *   - Itiraz kabul edilirse onaylayanlar cezalaniyor mu?  (kesilmeli + men)
 *   - Asilsiz itiraz bedava mi?                           (teminati kesilmeli)
 *   - Kotu onay verip hemen cekim baslatmak kacis mi?     (olmamali)
 *   - Progresif teminat raporun rakamlarini veriyor mu?
 *
 * Not: Bu dosya sifreli havuzu da gercek FHE ile kurar; acilim talebi bos bir
 * havuzda acilamaz.
 */
describe("VeriarfyStaking — guvenilmez dugum riski (rapor §2.7)", () => {
  let owner: Signer;
  let researcher: Signer;
  let alice: Signer;
  let nodeA: Signer;
  let nodeB: Signer;
  let nodeC: Signer;
  let nodeD: Signer;

  let protocol: any;
  let staking: any;

  /** Test agi icin kucultulmus taban teminat; uretim hedefi 32 ETH. */
  const BASE_STAKE = ethers.parseEther("1");
  const VALUE_THRESHOLD = 250_000n;
  const CHALLENGE_PERIOD = 50;
  const VOTING_PERIOD = 3_600;

  const STATISTICS = 4;
  const BASE_FEE = 10_000_000n;
  const PER_PARTICIPANT_FEE = 1_000_000n;

  const CIRCUITS = join(__dirname, "..", "..", "circuits");
  const IDENTITY_WASM = join(
    CIRCUITS, "build", "researcher_identity_js", "researcher_identity.wasm",
  );
  const IDENTITY_ZKEY = join(CIRCUITS, "build", "researcher_identity_final.zkey");

  let circuits: any;
  let snarkjs: any;

  before(async () => {
    if (!existsSync(IDENTITY_ZKEY)) {
      throw new Error("Devre ciktilari yok. Once `npm run circuits:build` calistirin.");
    }
    circuits = await import("@veriarfy/circuits");
    snarkjs = await import("snarkjs");
  });

  beforeEach(async () => {
    [owner, researcher, alice, nodeA, nodeB, nodeC, nodeD] = await ethers.getSigners();

    const ProvVerifier = await ethers.getContractFactory("DataProvenanceVerifier");
    const provVerifier = await ProvVerifier.deploy();
    await provVerifier.waitForDeployment();

    const Protocol = await protocolFactory();
    // Esik 2, k-anonimlik 1 (bu dosyanin konusu k-anonimlik degil).
    protocol = await Protocol.deploy(
      await owner.getAddress(), 2, 1,
      await provVerifier.getAddress(),
      ethers.ZeroHash,
    );
    await protocol.waitForDeployment();

    const Staking = await ethers.getContractFactory("VeriarfyStaking");
    staking = await Staking.deploy(
      await owner.getAddress(),
      await protocol.getAddress(),
      BASE_STAKE,
      VALUE_THRESHOLD,
    );
    await staking.waitForDeployment();

    await protocol.connect(owner).setStakingModule(await staking.getAddress());
    await protocol.connect(owner).setChallengePeriod(CHALLENGE_PERIOD);

    for (const n of [nodeA, nodeB, nodeC, nodeD]) {
      await protocol.connect(owner).authorizeNode(await n.getAddress());
    }

    // Havuza gercek sifreli bir katki: acilim talebi bos havuzda acilamaz.
    const enc = await fhevm
      .createEncryptedInput(await protocol.getAddress(), await alice.getAddress())
      .add8(0)
      .add8(1)
      .encrypt();
    await protocol
      .connect(alice)
      .aggregateDosage(enc.handles[0], enc.handles[1], enc.inputProof);

    // Kapiyi sahibe ver ki testler dogrudan talep acabilsin.
    await protocol.connect(owner).setQueryGateway(await owner.getAddress());
  });

  async function stakeAll(nodes: Signer[], amount = BASE_STAKE) {
    for (const n of nodes) {
      await staking.connect(n).stake({ value: amount });
    }
  }

  /**
   * Gercek odeme yigini kurar: token + ZK kimlikli arastirmaci kaydi + odemeler.
   *
   * Ucret hacmini taklit eden bir yardimci sozlesme YAZILMADI; `cumulativeFees`
   * yalnizca gercek bir sorgunun gercekten dagitilmasiyla artar.
   */
  async function deployPayments() {
    const Token = await ethers.getContractFactory("StableTestToken");
    const token = await Token.deploy(await owner.getAddress());
    await token.waitForDeployment();

    const identityTree = new circuits.IdentityTree();
    const identity = circuits.createIdentity();
    identityTree.insert(identity.commitment);

    const Verifier = await ethers.getContractFactory("Groth16Verifier");
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();

    const Registry = await ethers.getContractFactory("VeriArfyRegistry");
    const registry = await Registry.deploy(await verifier.getAddress(), identityTree.root);
    await registry.waitForDeployment();

    const { proof } = await snarkjs.groth16.fullProve(
      circuits.buildCircuitInput({
        identity,
        tree: identityTree,
        externalNullifier: 1n,
        signerAddress: await researcher.getAddress(),
      }),
      IDENTITY_WASM,
      IDENTITY_ZKEY,
    );
    const cd = circuits.toSolidityCalldata(proof);
    await registry
      .connect(researcher)
      .register(
        identityTree.root,
        circuits.computeNullifierHash(1n, identity.nullifier),
        cd.a, cd.b, cd.c,
      );

    const Payments = await ethers.getContractFactory("VeriarfyPayments");
    const payments = await Payments.deploy(
      await owner.getAddress(),
      await token.getAddress(),
      await protocol.getAddress(),
      await registry.getAddress(),
      8_000,
      BASE_FEE,
      PER_PARTICIPANT_FEE,
    );
    await payments.waitForDeployment();

    await protocol.connect(owner).setQueryGateway(await payments.getAddress());
    await token.connect(owner).mint(await researcher.getAddress(), 1_000_000_000n);
    await token
      .connect(researcher)
      .approve(await payments.getAddress(), ethers.MaxUint256);

    return { token, payments };
  }

  /** Bastan sona gercek bir sorgu yurutur ve odenen ucreti dondurur. */
  async function runRealQuery() {
    const { payments } = await deployPayments();

    // Izin adimi KALKTI: havuza yuklemek zaten izindir.
    await stakeAll([nodeA, nodeB]);
    await payments.connect(researcher).openQuery(STATISTICS);
    const queryId = (await payments.nextQueryId()) - 1n;
    const q = await payments.query(queryId);

    await protocol.connect(nodeA).approveDisclosure(q.disclosureRequestId);
    await protocol.connect(nodeB).approveDisclosure(q.disclosureRequestId);
    await mine(CHALLENGE_PERIOD);
    await protocol.executeDisclosure(q.disclosureRequestId);
    await payments.settleQuery(queryId);

    return { payments, fee: q.fee as bigint };
  }

  /** Bir acilim talebi acar ve kimligini dondurur. */
  async function openRequest(): Promise<bigint> {
    const id = await protocol.nextRequestId();
    await protocol
      .connect(owner)
      .requestDisclosure(await researcher.getAddress(), STATISTICS);
    return id;
  }

  // ===================================================================================
  // 1) Progresif teminat — rapor §2.7.1 formulu
  // ===================================================================================

  describe("Progresif teminat: MinStake = BaseStake x log2(TotalDataValue / Threshold)", () => {
    /**
     * Formulun kendisi `RarityMathHarness` ile dogrulanir: uretim
     * kutuphanesinin AYNISI, yalnizca disaridan cagrilabilir hale getirilmis
     * hali. Raporun 32/64/256 ETH rakamlarini 100M USD'lik gercek bir ucret
     * hacmi olusturmadan boyle dogrulayabiliyoruz.
     */
    let math: any;

    beforeEach(async () => {
      const Math_ = await ethers.getContractFactory("RarityMathHarness");
      math = await Math_.deploy();
      await math.waitForDeployment();
    });

    it("raporun 1M USD kontrol noktasi: teminat 2 katina cikar", async () => {
      // Rapor §2.7.1: "Ag degeri 1M USD'yi astiginda MinStake 64 ETH'ye" —
      // taban 32 ETH oldugundan carpan 2. Threshold = 250.000 bu noktayi
      // BIREBIR tutturur: log2(1.000.000 / 250.000) = log2(4) = 2.
      //
      // `multiplierBps(x-1, 1)` = log2(x) kimligi kullanilir.
      expect(await math.multiplierBps(3, 1)).to.equal(20_000n); // log2(4) = 2,00
    });

    it("100M USD noktasinda formul raporun verdiginden DAHA YUKSEK cikiyor", async () => {
      // log2(100.000.000 / 250.000) = log2(400) = 8,64.
      // Rapor 256/32 = 8 kat diyor. Sapma YUKARI yonde: raporun vaat
      // ettiginden daha pahali bir koalisyon saldirisi. Ters secim, vaat
      // edilenden UCUZ bir saldiri anlamina gelirdi.
      const bps = await math.multiplierBps(399, 1);
      expect(bps).to.be.closeTo(86_438n, 10n);
    });

    it("odeme sozlesmesi bagli degilken taban teminat gecerlidir", async () => {
      expect(await staking.minStake()).to.equal(BASE_STAKE);
    });

    it("GERCEK ucret hacmi teminati yukseltir", async () => {
      // Burada hicbir sey taklit edilmez: gercek bir sorgu acilir, gercek
      // BSKK-44 onayindan gecer, gercek ucret dagitilir ve `cumulativeFees`
      // bundan olusur.
      const { payments, fee } = await runRealQuery();
      expect(await payments.cumulativeFees()).to.equal(fee);

      // Esigi, gercek hacmin dortte birine kur -> oran 4 -> carpan tam 2.
      await staking.connect(owner).setPayments(await payments.getAddress());
      await staking.connect(owner).setParameters(BASE_STAKE, fee / 4n);

      expect(await staking.minStake()).to.equal(BASE_STAKE * 2n);
    });

    it("esigin altinda taban teminat KORUNUR — formul sifira dusurmez", async () => {
      // Formul oldugu gibi uygulansaydi log2(x<1) negatif olur ve sistemin en
      // kirilgan oldugu ilk gunlerde teminat sifira inerdi.
      const { payments, fee } = await runRealQuery();
      await staking.connect(owner).setPayments(await payments.getAddress());
      await staking.connect(owner).setParameters(BASE_STAKE, fee * 100n);

      expect(await staking.minStake()).to.equal(BASE_STAKE);
    });

    it("iade edilen sorgu hacme SAYILMAZ", async () => {
      // Iade, sistemden deger gecmedigi anlamina gelir. Sayilsaydi bir
      // arastirmaci sorgu acip iade alarak teminat esigini suni sekilde
      // yukseltip dugumleri disari itebilirdi.
      const { payments } = await deployPayments();
      expect(await payments.cumulativeFees()).to.equal(0);
    });
  });

  // ===================================================================================
  // 2) Teminat, onay yetkisinin sarti
  // ===================================================================================

  describe("Teminat olmadan onay yok", () => {
    it("teminatsiz yetkili dugum onay VEREMEZ", async () => {
      const requestId = await openRequest();
      await expect(
        protocol.connect(nodeA).approveDisclosure(requestId),
      ).to.be.revertedWithCustomError(protocol, "NodeNotStaked");
    });

    it("eksik teminat da yetmez", async () => {
      await staking.connect(nodeA).stake({ value: BASE_STAKE - 1n });
      const requestId = await openRequest();
      await expect(
        protocol.connect(nodeA).approveDisclosure(requestId),
      ).to.be.revertedWithCustomError(protocol, "NodeNotStaked");
    });

    it("yeterli teminatla onay gecer", async () => {
      await stakeAll([nodeA]);
      const requestId = await openRequest();
      await expect(protocol.connect(nodeA).approveDisclosure(requestId)).to.not.be
        .reverted;
    });

    it("cekim kuyruguna alinan tutar ANINDA teminat olmaktan cikar", async () => {
      // Aksi halde dugum, kotu onaydan sonra cekim baslatip itiraz suresi
      // boyunca teminatli gorunur, sure biter bitmez parasini alirdi.
      await stakeAll([nodeA]);
      expect(await staking.canApprove(await nodeA.getAddress())).to.equal(true);

      await staking.connect(nodeA).requestUnstake(BASE_STAKE);
      expect(await staking.canApprove(await nodeA.getAddress())).to.equal(false);
    });

    it("teminat bekleme suresi dolmadan cekilemez", async () => {
      await stakeAll([nodeA]);
      await staking.connect(nodeA).requestUnstake(BASE_STAKE);

      await expect(staking.connect(nodeA).withdraw()).to.be.revertedWithCustomError(
        staking, "UnbondingActive",
      );

      await mine(7_200);
      await expect(staking.connect(nodeA).withdraw()).to.not.be.reverted;
    });
  });

  describe("D15 M-of-N contract regression", () => {
    it("D15: tek onay acilimi finalize etmez, iki bagimsiz stake onayi eder", async () => {
      expect(await protocol.stakingModule()).to.equal(await staking.getAddress());
      expect(await protocol.isAuthorizedNode(await nodeA.getAddress())).to.equal(true);
      expect(await protocol.isAuthorizedNode(await nodeB.getAddress())).to.equal(true);

      await stakeAll([nodeA, nodeB]);
      expect(await staking.stakeOf(await nodeA.getAddress())).to.equal(BASE_STAKE);
      expect(await staking.stakeOf(await nodeB.getAddress())).to.equal(BASE_STAKE);

      const requestId = await openRequest();
      expect(await protocol.requiredApprovals(STATISTICS)).to.equal(2);
      expect(await protocol.disclosureRequiredApprovals(requestId)).to.equal(2);
      await expect(
        protocol.disclosureRequiredApprovals(requestId + 1n),
      ).to.be.revertedWithCustomError(protocol, "UnknownRequest");

      await protocol.connect(nodeA).approveDisclosure(requestId);
      expect(await protocol.isDisclosureFinalized(requestId)).to.equal(false);

      await protocol.connect(nodeB).approveDisclosure(requestId);
      expect(await protocol.isDisclosureFinalized(requestId)).to.equal(true);
    });
  });

  // ===================================================================================
  // 3) Itiraz suresi — rapor §2.7.1
  // ===================================================================================

  describe("Itiraz suresi", () => {
    it("esige ulasmak cozum yetkisi VERMEZ", async () => {
      await stakeAll([nodeA, nodeB]);
      const requestId = await openRequest();
      await protocol.connect(nodeA).approveDisclosure(requestId);
      await protocol.connect(nodeB).approveDisclosure(requestId);

      expect(await protocol.isDisclosureFinalized(requestId)).to.equal(true);
      // Kritik ayrim: esik saglandi ama yetki HENUZ verilmedi.
      expect(await protocol.isDisclosureGranted(requestId)).to.equal(false);
    });

    it("sure dolmadan yurutme reddedilir", async () => {
      await stakeAll([nodeA, nodeB]);
      const requestId = await openRequest();
      await protocol.connect(nodeA).approveDisclosure(requestId);
      await protocol.connect(nodeB).approveDisclosure(requestId);

      await expect(
        protocol.executeDisclosure(requestId),
      ).to.be.revertedWithCustomError(protocol, "ChallengePeriodOpen");
    });

    it("sure dolunca herkes yurutebilir", async () => {
      await stakeAll([nodeA, nodeB]);
      const requestId = await openRequest();
      await protocol.connect(nodeA).approveDisclosure(requestId);
      await protocol.connect(nodeB).approveDisclosure(requestId);

      await mine(CHALLENGE_PERIOD);

      // Yetkinin verilmesi birinin insafina birakilmaz: sartlarin tamami
      // zincirde gorunur olgulardir.
      await expect(protocol.connect(alice).executeDisclosure(requestId)).to.not.be
        .reverted;
      expect(await protocol.isDisclosureGranted(requestId)).to.equal(true);
    });

    it("sure sonradan degistirilse bile ACIK talebin penceresi kaymaz", async () => {
      await stakeAll([nodeA, nodeB]);
      const requestId = await openRequest();
      await protocol.connect(nodeA).approveDisclosure(requestId);
      await protocol.connect(nodeB).approveDisclosure(requestId);

      const windowEnd = await protocol.challengeWindowEnd(requestId);

      // Sahip sureyi 10 katina cikarir — gecmise donuk etki OLMAMALI.
      await protocol.connect(owner).setChallengePeriod(CHALLENGE_PERIOD * 10);
      expect(await protocol.challengeWindowEnd(requestId)).to.equal(windowEnd);

      await mine(CHALLENGE_PERIOD);
      await expect(protocol.executeDisclosure(requestId)).to.not.be.reverted;
    });
  });

  // ===================================================================================
  // 4) Itiraz ve slashing
  // ===================================================================================

  describe("Itiraz, oylama ve slashing", () => {
    async function finalizedRequest(): Promise<bigint> {
      await stakeAll([nodeA, nodeB, nodeC, nodeD]);
      const requestId = await openRequest();
      await protocol.connect(nodeA).approveDisclosure(requestId);
      await protocol.connect(nodeB).approveDisclosure(requestId);
      return requestId;
    }

    it("onaylayan dugum kendi kararina itiraz EDEMEZ", async () => {
      const requestId = await finalizedRequest();
      await expect(
        staking.connect(nodeA).challenge(requestId, { value: await staking.challengeBond() }),
      ).to.be.revertedWithCustomError(staking, "ApproverCannotChallenge");
    });

    it("teminatsiz dugum itiraz edemez", async () => {
      await stakeAll([nodeA, nodeB]);
      const requestId = await openRequest();
      await protocol.connect(nodeA).approveDisclosure(requestId);
      await protocol.connect(nodeB).approveDisclosure(requestId);

      await expect(
        staking.connect(nodeC).challenge(requestId, { value: await staking.challengeBond() }),
      ).to.be.revertedWithCustomError(staking, "BelowMinimum");
    });

    it("itiraz teminatsiz acilamaz — bedava geciktirme yok", async () => {
      const requestId = await finalizedRequest();
      await expect(
        staking.connect(nodeC).challenge(requestId, { value: 0 }),
      ).to.be.revertedWithCustomError(staking, "WrongBond");
    });

    it("sure dolduktan sonra itiraz edilemez", async () => {
      const requestId = await finalizedRequest();
      await mine(CHALLENGE_PERIOD);

      await expect(
        staking.connect(nodeC).challenge(requestId, { value: await staking.challengeBond() }),
      ).to.be.revertedWithCustomError(staking, "ChallengeWindowClosed");
    });

    it("cozulmemis itiraz, sure dolsa bile yurutmeyi ENGELLER", async () => {
      // Bu kontrol olmasaydi itiraz, oylamasi bitmeden yurutulen bir acilimi
      // durduramazdi — ve `FHE.allow` geri alinamadigi icin itiraz anlamsiz
      // kalirdi.
      const requestId = await finalizedRequest();
      await staking
        .connect(nodeC)
        .challenge(requestId, { value: await staking.challengeBond() });

      await mine(CHALLENGE_PERIOD);

      await expect(
        protocol.executeDisclosure(requestId),
      ).to.be.revertedWithCustomError(protocol, "ChallengeUnresolved");
    });

    it("itiraz KABUL edilirse onaylayanlar kesilir ve kalici men edilir", async () => {
      const requestId = await finalizedRequest();
      const bond = await staking.challengeBond();

      await staking.connect(nodeC).challenge(requestId, { value: bond });
      const [, challengeId] = await staking.challengeOf(requestId);

      // Onaylamayan dugumler oy verir; ikisi de kabul yonunde.
      await staking.connect(nodeC).voteOnChallenge(challengeId, true);
      await staking.connect(nodeD).voteOnChallenge(challengeId, true);

      await mine(VOTING_PERIOD);
      await expect(staking.resolveChallenge(challengeId))
        .to.emit(staking, "ChallengeResolved")
        .withArgs(challengeId, true, BASE_STAKE * 2n);

      for (const n of [nodeA, nodeB]) {
        const addr = await n.getAddress();
        expect(await staking.stakeOf(addr)).to.equal(0);
        expect(await staking.isBanned(addr)).to.equal(true);
        // Yetki de dusmeli: teminatsiz kalan dugum onay vermeye devam edemez.
        expect(await protocol.isAuthorizedNode(addr)).to.equal(false);
      }

      // Acilim iptal edildi; yetki HICBIR ZAMAN verilmedi.
      expect(await protocol.isDisclosureRevoked(requestId)).to.equal(true);
      await expect(
        protocol.executeDisclosure(requestId),
      ).to.be.revertedWithCustomError(protocol, "DisclosureRevoked");
    });

    it("men edilen dugum yeniden teminat yatiramaz", async () => {
      const requestId = await finalizedRequest();
      await staking
        .connect(nodeC)
        .challenge(requestId, { value: await staking.challengeBond() });
      const [, challengeId] = await staking.challengeOf(requestId);
      await staking.connect(nodeC).voteOnChallenge(challengeId, true);
      await staking.connect(nodeD).voteOnChallenge(challengeId, true);
      await mine(VOTING_PERIOD);
      await staking.resolveChallenge(challengeId);

      await expect(
        staking.connect(nodeA).stake({ value: BASE_STAKE }),
      ).to.be.revertedWithCustomError(staking, "NodeIsBanned");
    });

    it("ASILSIZ itiraz edenin teminati kesilir", async () => {
      const requestId = await finalizedRequest();
      const bond = await staking.challengeBond();

      await staking.connect(nodeC).challenge(requestId, { value: bond });
      const [, challengeId] = await staking.challengeOf(requestId);

      // Oylar reddetme yonunde.
      await staking.connect(nodeC).voteOnChallenge(challengeId, false);
      await staking.connect(nodeD).voteOnChallenge(challengeId, false);

      await mine(VOTING_PERIOD);
      await expect(staking.resolveChallenge(challengeId))
        .to.emit(staking, "ChallengeResolved")
        .withArgs(challengeId, false, bond);

      // Onaylayanlar zarar gormez.
      expect(await staking.stakeOf(await nodeA.getAddress())).to.equal(BASE_STAKE);
      expect(await staking.isBanned(await nodeA.getAddress())).to.equal(false);

      // Itiraz reddedildi -> acilim devam eder.
      await expect(protocol.executeDisclosure(requestId)).to.not.be.reverted;
    });

    it("HIC OY KULLANILMAZSA itiraz reddedilir", async () => {
      // Kimsenin desteklemedigi bir iddia dugum kesmeye yetmemeli.
      const requestId = await finalizedRequest();
      const bond = await staking.challengeBond();
      await staking.connect(nodeC).challenge(requestId, { value: bond });
      const [, challengeId] = await staking.challengeOf(requestId);

      await mine(VOTING_PERIOD);
      await expect(staking.resolveChallenge(challengeId))
        .to.emit(staking, "ChallengeResolved")
        .withArgs(challengeId, false, bond);

      expect(await staking.isBanned(await nodeA.getAddress())).to.equal(false);
    });

    it("2/3 esigi: 1 kabul / 1 ret YETMEZ", async () => {
      const requestId = await finalizedRequest();
      await staking
        .connect(nodeC)
        .challenge(requestId, { value: await staking.challengeBond() });
      const [, challengeId] = await staking.challengeOf(requestId);

      await staking.connect(nodeC).voteOnChallenge(challengeId, true);
      await staking.connect(nodeD).voteOnChallenge(challengeId, false);

      await mine(VOTING_PERIOD);
      await staking.resolveChallenge(challengeId);

      // 1/2 = %50 < 2/3 -> reddedilir.
      expect(await staking.isBanned(await nodeA.getAddress())).to.equal(false);
    });

    it("onaylayan dugum oy KULLANAMAZ", async () => {
      const requestId = await finalizedRequest();
      await staking
        .connect(nodeC)
        .challenge(requestId, { value: await staking.challengeBond() });
      const [, challengeId] = await staking.challengeOf(requestId);

      // Kendi kararini yargilamak denetimi anlamsiz kilardi.
      await expect(
        staking.connect(nodeA).voteOnChallenge(challengeId, false),
      ).to.be.revertedWithCustomError(staking, "ApproverCannotVote");
    });

    it("oylama bitmeden sonuc uygulanamaz", async () => {
      const requestId = await finalizedRequest();
      await staking
        .connect(nodeC)
        .challenge(requestId, { value: await staking.challengeBond() });
      const [, challengeId] = await staking.challengeOf(requestId);

      await expect(
        staking.resolveChallenge(challengeId),
      ).to.be.revertedWithCustomError(staking, "VotingStillOpen");
    });

    it("ayni acilima iki kez itiraz edilemez", async () => {
      const requestId = await finalizedRequest();
      const bond = await staking.challengeBond();
      await staking.connect(nodeC).challenge(requestId, { value: bond });

      await expect(
        staking.connect(nodeD).challenge(requestId, { value: bond }),
      ).to.be.revertedWithCustomError(staking, "AlreadyChallenged");
    });

    it("cekim kuyrugundaki tutar da kesilir — ceza atlatilamaz", async () => {
      // Kotu onay verip hemen cekim baslatmak, cezadan kacmanin yolu olmamali.
      const requestId = await finalizedRequest();
      await staking.connect(nodeA).requestUnstake(BASE_STAKE);
      expect(await staking.unbonding(await nodeA.getAddress())).to.equal(BASE_STAKE);

      const bond = await staking.challengeBond();
      await staking.connect(nodeC).challenge(requestId, { value: bond });
      const [, challengeId] = await staking.challengeOf(requestId);
      await staking.connect(nodeC).voteOnChallenge(challengeId, true);
      await staking.connect(nodeD).voteOnChallenge(challengeId, true);
      await mine(VOTING_PERIOD);
      await staking.resolveChallenge(challengeId);

      expect(await staking.unbonding(await nodeA.getAddress())).to.equal(0);
      await expect(staking.connect(nodeA).withdraw()).to.be.revertedWithCustomError(
        staking, "NoUnbondingRequest",
      );
    });

    it("kesilen teminat havuzda toplanir ve hazineye aktarilabilir", async () => {
      const requestId = await finalizedRequest();
      const bond = await staking.challengeBond();
      await staking.connect(nodeC).challenge(requestId, { value: bond });
      const [, challengeId] = await staking.challengeOf(requestId);
      await staking.connect(nodeC).voteOnChallenge(challengeId, true);
      await staking.connect(nodeD).voteOnChallenge(challengeId, true);
      await mine(VOTING_PERIOD);
      await staking.resolveChallenge(challengeId);

      // Rapor "yakilir" diyor; burada toplanir. Zarar goren taraf
      // katilimcilardir, tazminatin kaynagi olmasi degeri yok etmekten iyidir.
      expect(await staking.slashedPool()).to.equal(BASE_STAKE * 2n);

      const treasury = await nodeD.getAddress();
      const before = await ethers.provider.getBalance(treasury);
      await staking.connect(owner).withdrawSlashed(treasury);
      expect(await ethers.provider.getBalance(treasury)).to.equal(
        before + BASE_STAKE * 2n,
      );
      expect(await staking.slashedPool()).to.equal(0);
    });
  });

  // ===================================================================================
  // 5) Modul kapali haldeyken eski davranis korunur
  // ===================================================================================

  describe("Modul bagli degilken", () => {
    it("teminat aranmaz — protokol modulsuz de calisir", async () => {
      await protocol.connect(owner).setStakingModule(ethers.ZeroAddress);
      await protocol.connect(owner).setChallengePeriod(0);

      const requestId = await openRequest();
      await protocol.connect(nodeA).approveDisclosure(requestId);
      await protocol.connect(nodeB).approveDisclosure(requestId);
      await expect(protocol.executeDisclosure(requestId)).to.not.be.reverted;
    });

    it("yalnizca sahip ve modul dugum yetkisini dusurebilir", async () => {
      await expect(
        protocol.connect(alice).revokeNode(await nodeA.getAddress()),
      ).to.be.revertedWithCustomError(protocol, "NotStakingModule");
    });
  });
});
