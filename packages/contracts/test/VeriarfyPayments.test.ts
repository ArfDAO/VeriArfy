import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import type { Signer } from "ethers";
import { protocolFactory } from "./helpers/factories";

/**
 * Hesaplama basina odeme ve gelir paylasimi.
 *
 * Rapor §4.1 ve §4.2'nin kod karsiligi. Testlerin dogruladigi sorular:
 *
 *   - Ucret gercekten katilimci sayisiyla mi artiyor (pay-per-compute)?
 *   - %80 / %20 bolusme kurusuna dogru mu?
 *   - Sorgudan SONRA katilan biri o sorgudan pay alabiliyor mu? (alamamali)
 *   - Ayni pay iki kez cekilebiliyor mu? (cekilememeli)
 *   - Kayitsiz bir adres sorgu acabiliyor mu? (acamamali)
 *   - Bolme kusurati kontratta kilitli kaliyor mu? (kalmamali)
 *
 * Zincirdeki her adim gercektir: ZK kaydi gercek Groth16 kanitiyla, koken
 * kaydi gercek EdDSA kanitiyla, sifreli dozaj gercek FHE ile yapilir.
 */
describe("VeriarfyPayments", () => {
  let owner: Signer;
  let researcher: Signer;
  let alice: Signer;
  let bob: Signer;
  let carol: Signer;
  let outsider: Signer;
  let nodeA: Signer;
  let nodeB: Signer;

  let token: any;
  let protocol: any;
  let payments: any;
  let registry: any;

  const CIRCUITS = join(__dirname, "..", "..", "circuits");
  const IDENTITY_WASM = join(
    CIRCUITS, "build", "researcher_identity_js", "researcher_identity.wasm",
  );
  const IDENTITY_ZKEY = join(CIRCUITS, "build", "researcher_identity_final.zkey");
  const PROVENANCE_WASM = join(
    CIRCUITS, "build", "data_provenance_js", "data_provenance.wasm",
  );
  const PROVENANCE_ZKEY = join(CIRCUITS, "build", "data_provenance_final.zkey");

  /**
   * Test paneli devrenin `PANEL_SIZE`'indan turetilir; sabit uzunluk yazilmaz.
   *
   * Panel buyudugunde sabit dizi "uzunluk uyusmuyor" ile duserdi. Testin
   * dogruladigi sey uzunluk degil DAVRANISTIR; boyuta bagimli olmamali.
   */
  let PANEL: number[];

  /** USDC ile ayni: 6 ondalik. 10 tUSD taban, katilimci basina 1 tUSD. */
  const BASE_FEE = 10_000_000n;
  const PER_PARTICIPANT_FEE = 1_000_000n;
  const LIQUIDITY_SHARE_BPS = 8_000; // %80 — rapor §4.2

  let circuits: any;
  let provenanceLib: any;
  let snarkjs: any;
  let institutionRegistry: any;
  let institution: any;

  before(async () => {
    if (!existsSync(PROVENANCE_ZKEY) || !existsSync(IDENTITY_ZKEY)) {
      throw new Error("Devre ciktilari yok. Once `npm run circuits:build` calistirin.");
    }
    circuits = await import("@veriarfy/circuits");
    provenanceLib = await import("@veriarfy/circuits/provenance");
    PANEL = Array.from(
      { length: provenanceLib.PANEL_SIZE },
      (_: unknown, i: number) => [0, 1, 2, 1, 0, 2][i % 6],
    );
    snarkjs = await import("snarkjs");

    ({ institution, registry: institutionRegistry } =
      await provenanceLib.developmentRegistry());
  });

  beforeEach(async () => {
    [owner, researcher, alice, bob, carol, outsider, nodeA, nodeB] =
      await ethers.getSigners();

    // --- Odeme token'i (gercek OZ ERC-20) --------------------------------
    const Token = await ethers.getContractFactory("StableTestToken");
    token = await Token.deploy(await owner.getAddress());
    await token.waitForDeployment();

    // --- Arastirmaci kimlik kaydi (GERCEK ZK) ----------------------------
    const identityTree = new circuits.IdentityTree();
    const identity = circuits.createIdentity();
    identityTree.insert(identity.commitment);

    const Verifier = await ethers.getContractFactory("Groth16Verifier");
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();

    const Registry = await ethers.getContractFactory("VeriArfyRegistry");
    registry = await Registry.deploy(await verifier.getAddress(), identityTree.root);
    await registry.waitForDeployment();

    const identityInput = circuits.buildCircuitInput({
      identity,
      tree: identityTree,
      externalNullifier: 1n,
      signerAddress: await researcher.getAddress(),
    });
    const { proof: identityProof } = await snarkjs.groth16.fullProve(
      identityInput, IDENTITY_WASM, IDENTITY_ZKEY,
    );
    const idCalldata = circuits.toSolidityCalldata(identityProof);
    await registry
      .connect(researcher)
      .register(
        identityTree.root,
        circuits.computeNullifierHash(1n, identity.nullifier),
        idCalldata.a, idCalldata.b, idCalldata.c,
      );

    // --- Protokol --------------------------------------------------------
    const ProvVerifier = await ethers.getContractFactory("DataProvenanceVerifier");
    const provVerifier = await ProvVerifier.deploy();
    await provVerifier.waitForDeployment();

    const Protocol = await protocolFactory();
    // minParticipants = 1: k-anonimlik bu dosyanin konusu degil, odeme akisi.
    // Esik davranisi `VeriarfyProtocol.test.ts` ve `GwasChiSquare.test.ts`
    // icinde ayrica dogrulanir.
    protocol = await Protocol.deploy(
      await owner.getAddress(), 2, 1,
      await provVerifier.getAddress(),
      institutionRegistry.root,
    );
    await protocol.waitForDeployment();

    // BSKK-44 dugumleri: acilim onayi bunlardan gelir (rapor §2.6).
    // 2 dugum ile QUERY_TYPE_STATISTICS (4/10) -> ceil(2*4/10) = 1 onay.
    for (const node of [nodeA, nodeB]) {
      await protocol.connect(owner).authorizeNode(await node.getAddress());
    }

    // --- Odemeler --------------------------------------------------------
    const Payments = await ethers.getContractFactory("VeriarfyPayments");
    payments = await Payments.deploy(
      await owner.getAddress(),
      await token.getAddress(),
      await protocol.getAddress(),
      await registry.getAddress(),
      LIQUIDITY_SHARE_BPS,
      BASE_FEE,
      PER_PARTICIPANT_FEE,
    );
    await payments.waitForDeployment();

    // Sorgu kapisi: acilim talebini yalnizca odeme sozlesmesi acabilir.
    await protocol.connect(owner).setQueryGateway(await payments.getAddress());

    // Arastirmaciya bakiye ver ve harcama izni ac.
    await token.connect(owner).mint(await researcher.getAddress(), 1_000_000_000n);
    await token
      .connect(researcher)
      .approve(await payments.getAddress(), ethers.MaxUint256);
  });

  /**
   * Bir katilimciyi havuza sokar: GERCEK FHE sifrelemesi ile.
   *
   * Grup (vaka/kontrol) de sifreli gonderilir; GWAS kontenjans tablosu bunu
   * gerektirir. Odeme testleri acisindan grup onemsizdir, kontrol secilir.
   */
  async function joinPool(signer: Signer, dosage: number, group = 0) {
    const enc = await fhevm
      .createEncryptedInput(await protocol.getAddress(), await signer.getAddress())
      .add8(group)
      .add8(dosage)
      .encrypt();
    await protocol
      .connect(signer)
      .aggregateDosage(enc.handles[0], enc.handles[1], enc.inputProof);
  }

  /**
   * Katilimci, arastirmaciya izin verir.
   *
   * Havuza girmek TEK BASINA yetmez: rapor §3.4'e gore veri ancak kullanicinin
   * acikca izin verdigi kurum tarafindan kullanilabilir. Ucret ve pay,
   * izin veren kisi sayisina gore hesaplanir.
   */
  async function grant(participant: Signer, to?: Signer) {
    const ALL_TYPES = 1 | 2 | 4; // GWAS | ML | STATISTICS
    await protocol
      .connect(participant)
      .grantAccess(await (to ?? researcher).getAddress(), ALL_TYPES, 0, 0);
  }

  /** Rapor §2.6: genel istatistik sorgusu -> 4/10 esik. */
  const STATISTICS = 4;

  /**
   * Sorgu acar, BSKK-44 onayini toplar ve ucreti dagitima acar.
   *
   * Rapor §2.6: sorgu, yetkili kurumlarin onayi olmadan yurutulemez. Ucret
   * onay gelene kadar EMANETTE bekler; `settleQuery` onu serbest birakir.
   */
  async function openAndSettle(): Promise<bigint> {
    await payments.connect(researcher).openQuery(STATISTICS);
    const queryId = (await payments.nextQueryId()) - 1n;

    const q = await payments.query(queryId);
    await protocol.connect(nodeA).approveDisclosure(q.disclosureRequestId);
    // Rapor §2.7.1: esik saglanir, sonra itiraz suresi. Burada sure 0 oldugu
    // icin acilim hemen yurutulebilir; suresi olan hal ayrica test edilir.
    await protocol.executeDisclosure(q.disclosureRequestId);

    await payments.settleQuery(queryId);
    return queryId;
  }

  /** Havuza gir + izin ver — testlerin cogunda ikisi birlikte gerekir. */
  async function joinAndGrant(signer: Signer, dosage: number) {
    await joinPool(signer, dosage);
    await grant(signer);
  }

  // -----------------------------------------------------------------------------------

  describe("Fiyatlandirma (pay-per-compute)", () => {
    it("ucret IZIN VEREN katilimci sayisiyla dogrusal artar", async () => {
      const researcherAddr = await researcher.getAddress();

      const [emptyFee, emptyCount] = await payments.quoteFor(researcherAddr);
      expect(emptyCount).to.equal(0);
      expect(emptyFee).to.equal(BASE_FEE);

      // Havuza girmek TEK BASINA ucreti artirmaz — izin sarttir.
      await joinPool(alice, 1);
      const [stillEmpty, stillZero] = await payments.quoteFor(researcherAddr);
      expect(stillZero).to.equal(0);
      expect(stillEmpty).to.equal(BASE_FEE);

      await grant(alice);
      const [oneFee, oneCount] = await payments.quoteFor(researcherAddr);
      expect(oneCount).to.equal(1);
      expect(oneFee).to.equal(BASE_FEE + PER_PARTICIPANT_FEE);

      await joinAndGrant(bob, 2);
      const [twoFee] = await payments.quoteFor(researcherAddr);
      expect(twoFee).to.equal(BASE_FEE + 2n * PER_PARTICIPANT_FEE);
    });

    it("izin baska bir arastirmaciya gecmez", async () => {
      await joinPool(alice, 1);
      await grant(alice, researcher);

      // Alice yalnizca `researcher`'a izin verdi; baskasi icin sayac 0.
      const [, forOutsider] = await payments.quoteFor(await outsider.getAddress());
      expect(forOutsider).to.equal(0);
    });

    it("bos havuzda sorgu acilamaz", async () => {
      await expect(payments.connect(researcher).openQuery(STATISTICS)).to.be.revertedWithCustomError(
        payments,
        "PoolEmpty",
      );
    });

    it("kayitsiz adres sorgu acamaz", async () => {
      await joinAndGrant(alice, 1);
      await token.connect(owner).mint(await outsider.getAddress(), 1_000_000_000n);
      await token
        .connect(outsider)
        .approve(await payments.getAddress(), ethers.MaxUint256);

      await expect(payments.connect(outsider).openQuery(STATISTICS)).to.be.revertedWithCustomError(
        payments,
        "NotRegisteredResearcher",
      );
    });
  });

  describe("Gelir paylasimi (RevShare)", () => {
    it("%80 katilimcilara, %20 hazineye ayrilir", async () => {
      await joinAndGrant(alice, 1);
      await joinAndGrant(bob, 2);

      const [fee] = await payments.quoteFor(await researcher.getAddress());
      await openAndSettle();

      const q = await payments.query(0);
      const expectedPot = (fee * BigInt(LIQUIDITY_SHARE_BPS)) / 10_000n;

      expect(q.fee).to.equal(fee);
      expect(q.liquidityPot).to.equal(expectedPot);
      expect(q.snapshotCount).to.equal(2);
      expect(await payments.treasuryBalance()).to.equal(fee - expectedPot);
    });

    it("katilimci payini ceker ve bakiyesi artar", async () => {
      await joinAndGrant(alice, 1);
      await joinAndGrant(bob, 2);
      await openAndSettle();

      const q = await payments.query(0);
      const perShare = q.liquidityPot / 2n;

      const before = await token.balanceOf(await alice.getAddress());
      await expect(payments.connect(alice).claim(0))
        .to.emit(payments, "RewardClaimed")
        .withArgs(0, await alice.getAddress(), perShare);

      expect(await token.balanceOf(await alice.getAddress())).to.equal(before + perShare);
    });

    it("ayni pay iki kez cekilemez", async () => {
      await joinAndGrant(alice, 1);
      await openAndSettle();

      await payments.connect(alice).claim(0);
      await expect(payments.connect(alice).claim(0)).to.be.revertedWithCustomError(
        payments,
        "AlreadyClaimed",
      );
    });

    it("havuza hic katilmayan pay alamaz", async () => {
      await joinAndGrant(alice, 1);
      await openAndSettle();

      await expect(payments.connect(outsider).claim(0)).to.be.revertedWithCustomError(
        payments,
        "NotAParticipant",
      );
    });

    it("sorgudan SONRA katilan o sorgudan pay ALAMAZ", async () => {
      await joinAndGrant(alice, 1);
      await openAndSettle(); // anlik goruntu: 1 katilimci

      // Carol sorgudan sonra katilip izin veriyor — verisi hesaplamaya girmedi.
      await joinAndGrant(carol, 2);

      await expect(payments.connect(carol).claim(0)).to.be.revertedWithCustomError(
        payments,
        "NotInThisQuery",
      );
      expect(await payments.claimable(0, await carol.getAddress())).to.equal(0);
    });

    it("sonraki sorguda yeni katilimci da pay alir", async () => {
      await joinAndGrant(alice, 1);
      await openAndSettle(); // sorgu 0: 1 katilimci

      await joinAndGrant(carol, 2);
      await openAndSettle(); // sorgu 1: 2 katilimci

      expect(await payments.claimable(1, await carol.getAddress())).to.be.greaterThan(0);
      await payments.connect(carol).claim(1);
    });

    it("odenen ile dagitilan+hazine birbirini tutar (kusurat dahil)", async () => {
      // 3 izin veren: havuz 3'e tam bolunmeyebilir, artik olusur.
      await joinAndGrant(alice, 1);
      await joinAndGrant(bob, 2);
      await joinAndGrant(carol, 0);

      const [fee] = await payments.quoteFor(await researcher.getAddress());
      await openAndSettle();

      for (const who of [alice, bob, carol]) {
        await payments.connect(who).claim(0);
      }

      // Artik hazineye tasinir; sonrasinda kontratta hicbir sey kilitli kalmaz.
      await payments.sweepDust(0);

      const distributed =
        (await token.balanceOf(await alice.getAddress())) +
        (await token.balanceOf(await bob.getAddress())) +
        (await token.balanceOf(await carol.getAddress()));

      expect(distributed + (await payments.treasuryBalance())).to.equal(fee);
      // Kontrat bakiyesi tam olarak hazine kadar olmali — fazlasi kilitli demektir.
      expect(await token.balanceOf(await payments.getAddress())).to.equal(
        await payments.treasuryBalance(),
      );
    });
  });

  describe("Gizlilik Paneli — izin ve iptal (rapor §3.4)", () => {
    it("veri yuklemeden izin verilemez", async () => {
      await expect(grant(alice)).to.be.revertedWithCustomError(protocol, "NotAParticipant");
    });

    it("izin kaydi panelin gosterecegi alanlari tasir", async () => {
      await joinPool(alice, 1);
      const expiry = (await ethers.provider.getBlockNumber()) + 1000;

      await protocol.connect(alice).grantAccess(await researcher.getAddress(), 1 | 4, expiry, 25);

      const p = await protocol.permission(
        await alice.getAddress(),
        await researcher.getAddress(),
      );
      expect(p.isAllowed).to.equal(true);
      expect(p.queryTypes).to.equal(5); // GWAS | STATISTICS
      expect(p.expirationBlock).to.equal(expiry);
      expect(p.maxQueries).to.equal(25);
      expect(p.revokedAtBlock).to.equal(ethers.MaxUint256);
    });

    it("ayni arastirmaciya iki kez izin verilemez", async () => {
      await joinAndGrant(alice, 1);
      await expect(grant(alice)).to.be.revertedWithCustomError(protocol, "AlreadyGranted");
    });

    it("IPTAL sonrasi acilan sorgudan pay ALINMAZ", async () => {
      await joinAndGrant(alice, 1);
      await joinAndGrant(bob, 2);

      // Alice izni geri aliyor — bundan SONRAKI sorgular onu kapsamaz.
      await protocol.connect(alice).revokeAccess(await researcher.getAddress());

      const [, count] = await payments.quoteFor(await researcher.getAddress());
      expect(count).to.equal(1); // yalnizca bob

      await openAndSettle();

      expect(await payments.claimable(0, await alice.getAddress())).to.equal(0);
      await expect(payments.connect(alice).claim(0)).to.be.revertedWithCustomError(
        payments,
        "NotInThisQuery",
      );
      expect(await payments.claimable(0, await bob.getAddress())).to.be.greaterThan(0);
    });

    it("IPTALDEN ONCE acilan sorgudan hak edilen pay KORUNUR", async () => {
      await joinAndGrant(alice, 1);
      await openAndSettle(); // sorgu 0 — alice dahil

      // Sorgu acildiktan sonra iptal: hakedis sorgunun ACILDIGI bloga bakar.
      await protocol.connect(alice).revokeAccess(await researcher.getAddress());

      expect(await payments.claimable(0, await alice.getAddress())).to.be.greaterThan(0);
      await payments.connect(alice).claim(0);
    });

    it("verilmemis izin iptal edilemez", async () => {
      await joinPool(alice, 1);
      await expect(
        protocol.connect(alice).revokeAccess(await researcher.getAddress()),
      ).to.be.revertedWithCustomError(protocol, "NoActiveGrant");
    });

    it("gecmis blokla suresi dolan izin verilemez", async () => {
      await joinPool(alice, 1);
      const past = await ethers.provider.getBlockNumber();
      await expect(
        protocol.connect(alice).grantAccess(await researcher.getAddress(), 1, past, 0),
      ).to.be.revertedWithCustomError(protocol, "ExpirationInPast");
    });

    it("bos sorgu tipi reddedilir", async () => {
      await joinPool(alice, 1);
      await expect(
        protocol.connect(alice).grantAccess(await researcher.getAddress(), 0, 0, 0),
      ).to.be.revertedWithCustomError(protocol, "EmptyQueryTypes");
    });

    it("bekleyen odul ozeti tek cagrida gelir", async () => {
      await joinAndGrant(alice, 1);
      await openAndSettle();
      await openAndSettle();

      const [total, ids] = await payments.pendingRewards(await alice.getAddress());
      expect(ids.length).to.equal(2);
      expect(total).to.be.greaterThan(0);

      await payments.connect(alice).claim(ids[0]);
      const [afterTotal, afterIds] = await payments.pendingRewards(await alice.getAddress());
      expect(afterIds.length).to.equal(1);
      expect(afterTotal).to.equal(total / 2n);
    });
  });

  describe("BSKK-44 emaneti (rapor §2.6)", () => {
    it("onay gelmeden ucret DAGITILMAZ", async () => {
      await joinAndGrant(alice, 1);
      await payments.connect(researcher).openQuery(STATISTICS);

      // Ucret alindi ama emanette; ne havuza ne hazineye gecti.
      const q = await payments.query(0);
      expect(q.settled).to.equal(false);
      expect(q.liquidityPot).to.equal(0);
      expect(await payments.treasuryBalance()).to.equal(0);
      expect(await payments.claimable(0, await alice.getAddress())).to.equal(0);
    });

    it("onay gelmeden pay CEKILEMEZ", async () => {
      await joinAndGrant(alice, 1);
      await payments.connect(researcher).openQuery(STATISTICS);

      await expect(payments.connect(alice).claim(0)).to.be.revertedWithCustomError(
        payments,
        "NotSettled",
      );
    });

    it("onay gelmeden settle EDILEMEZ", async () => {
      await joinAndGrant(alice, 1);
      await payments.connect(researcher).openQuery(STATISTICS);

      await expect(payments.settleQuery(0)).to.be.revertedWithCustomError(
        payments,
        "DisclosureNotGranted",
      );
    });

    it("onay gelince ucret dagitima acilir", async () => {
      await joinAndGrant(alice, 1);
      const [fee] = await payments.quoteFor(await researcher.getAddress());
      await openAndSettle();

      const q = await payments.query(0);
      expect(q.settled).to.equal(true);
      expect(q.liquidityPot).to.equal((fee * BigInt(LIQUIDITY_SHARE_BPS)) / 10_000n);
      expect(await payments.treasuryBalance()).to.equal(fee - q.liquidityPot);
    });

    it("ayni sorgu iki kez settle edilemez", async () => {
      await joinAndGrant(alice, 1);
      await openAndSettle();

      await expect(payments.settleQuery(0)).to.be.revertedWithCustomError(
        payments,
        "AlreadySettled",
      );
    });

    it("onay ONCESI iade icin bekleme suresi gerekir", async () => {
      await joinAndGrant(alice, 1);
      await payments.connect(researcher).openQuery(STATISTICS);

      await expect(
        payments.connect(researcher).refundQuery(0),
      ).to.be.revertedWithCustomError(payments, "RefundTooEarly");
    });

    it("bekleme sonrasi onay gelmediyse ucret IADE edilir", async () => {
      await joinAndGrant(alice, 1);
      const before = await token.balanceOf(await researcher.getAddress());
      const [fee] = await payments.quoteFor(await researcher.getAddress());

      await payments.connect(researcher).openQuery(STATISTICS);
      expect(await token.balanceOf(await researcher.getAddress())).to.equal(before - fee);

      // REFUND_DELAY kadar blok ilerlet.
      const delay = await payments.REFUND_DELAY();
      await ethers.provider.send("hardhat_mine", [`0x${delay.toString(16)}`]);

      await expect(payments.connect(researcher).refundQuery(0))
        .to.emit(payments, "QueryRefunded")
        .withArgs(0, await researcher.getAddress(), fee);

      expect(await token.balanceOf(await researcher.getAddress())).to.equal(before);
    });

    it("ONAY GELDIKTEN sonra iade edilemez", async () => {
      await joinAndGrant(alice, 1);
      await openAndSettle();

      const delay = await payments.REFUND_DELAY();
      await ethers.provider.send("hardhat_mine", [`0x${delay.toString(16)}`]);

      await expect(
        payments.connect(researcher).refundQuery(0),
      ).to.be.revertedWithCustomError(payments, "AlreadySettled");
    });

    it("sorgu sahibi olmayan iade isteyemez", async () => {
      await joinAndGrant(alice, 1);
      await payments.connect(researcher).openQuery(STATISTICS);

      const delay = await payments.REFUND_DELAY();
      await ethers.provider.send("hardhat_mine", [`0x${delay.toString(16)}`]);

      await expect(
        payments.connect(outsider).refundQuery(0),
      ).to.be.revertedWithCustomError(payments, "NotQueryOwner");
    });
  });

  describe("Hazine", () => {
    it("yalnizca sahip cekebilir", async () => {
      await joinAndGrant(alice, 1);
      await openAndSettle();

      await expect(
        payments.connect(outsider).withdrawTreasury(await outsider.getAddress()),
      ).to.be.revertedWithCustomError(payments, "OwnableUnauthorizedAccount");

      const balance = await payments.treasuryBalance();
      await expect(payments.connect(owner).withdrawTreasury(await owner.getAddress()))
        .to.emit(payments, "TreasuryWithdrawn")
        .withArgs(await owner.getAddress(), balance);

      expect(await payments.treasuryBalance()).to.equal(0);
    });

    it("katilimci payi degistirilemez (immutable)", async () => {
      expect(await payments.liquidityShareBps()).to.equal(LIQUIDITY_SHARE_BPS);
      expect((payments as any).setLiquidityShare).to.equal(undefined);
    });
  });
});
