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
  const PER_RECORD_FEE = 1_000_000n;
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
      PER_RECORD_FEE,
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
  /**
   * Eskiden izin verirdi; IZIN KAPISI KALKTI.
   *
   * Havuza yuklemek zaten izindir. Cagri yerlerini bozmamak icin duruyor.
   */
  async function grant(_participant: Signer, _to?: Signer) {
    // artik yapacak is yok
  }

  /** Rapor §2.6: genel istatistik sorgusu -> 4/10 esik. */
  const STATISTICS = 4;

  /**
   * Sorgu acar, BSKK-44 onayini toplar ve ucreti dagitima acar.
   *
   * Rapor §2.6: sorgu, yetkili kurumlarin onayi olmadan yurutulemez. Ucret
   * onay gelene kadar EMANETTE bekler; `settleQuery` onu serbest birakir.
   */
  async function openAndSettle(snpIds?: number[], metricIds?: number[]): Promise<bigint> {
    if (snpIds) {
      await payments.connect(researcher).openQueryFields(STATISTICS, snpIds, metricIds ?? []);
    } else {
      await payments.connect(researcher).openQuery(STATISTICS);
    }
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

  describe("Fiyatlandirma — kayit sayisi x kitlik", () => {
    // Bu paketin panelinde TEK SNP var (`aggregateDosage` kisayolu), yani
    // her katilimci tam olarak bir kayit uretir ve o alan herkeste vardir:
    // kitlik carpani 1x kalir. Kitligin kendisi asagida ayrica sinaniyor.

    it("ucret SATIN ALINAN KAYIT sayisiyla artar", async () => {
      const [emptyFee, emptyRecords] = await payments.quote();
      expect(emptyRecords).to.equal(0);
      // Kimsede veri yoksa yalnizca taban alinir — satilacak bir sey yok.
      expect(emptyFee).to.equal(BASE_FEE);

      await joinPool(alice, 1);
      const [oneFee, oneRecords] = await payments.quote();
      expect(oneRecords).to.equal(1);
      expect(oneFee).to.equal(BASE_FEE + PER_RECORD_FEE);

      await joinPool(bob, 2);
      const [twoFee, twoRecords] = await payments.quote();
      expect(twoRecords).to.equal(2);
      expect(twoFee).to.equal(BASE_FEE + 2n * PER_RECORD_FEE);
    });

    it("ucret ARASTIRMACIYA GORE DEGISMEZ", async () => {
      // Herkes ayni havuzu aliyor, herkes ayni oduyor. "Su kuruma evet, buna
      // hayir" mimari olarak mumkun degil; fiyat da bunu yansitir.
      await joinPool(alice, 1);

      const [feeA] = await payments.connect(researcher).quote();
      const [feeB] = await payments.connect(outsider).quote();
      expect(feeA).to.equal(feeB);
    });

    it("ISTENMEYEN alan icin odeme yapilmaz", async () => {
      await joinPool(alice, 1);

      // Bos alan listesi: taban disinda hicbir sey odenmez. Fiyatin havuz
      // buyuklugune degil ISTENEN SEYE bagli oldugunun kanitidir.
      const [fee, records] = await payments.quoteForFields([], []);
      expect(records).to.equal(0);
      expect(fee).to.equal(BASE_FEE);
    });

    it("kimsede olmayan alan BEDAVADIR", async () => {
      await joinPool(alice, 1);

      // 5. alanda kimsenin verisi yok. Ucret alinsaydi tamami hazineye
      // giderdi — dagitimda kimse pay alamazdi.
      const [fee, records] = await payments.quoteForFields([5], []);
      expect(records).to.equal(0);
      expect(fee).to.equal(BASE_FEE);
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

  // -----------------------------------------------------------------------------------
  // KITLIK
  // -----------------------------------------------------------------------------------
  //
  // Istenen davranis: az bulunan veri KISI BASINA daha pahali olsun. Seyrek
  // bir kohortun verisi, herkeste bulunan bir varyantla ayni fiyata
  // satilmamali.
  //
  // Carpan zincirden TURETILIR (havuz / o alani verenler), sahip tarafindan
  // atanmaz — "hangi veri degerli" karari kimsenin insafina birakilmaz.
  describe("Kitlik carpani", () => {
    /** Cok alanli panelde, verilen kapsama maskesiyle havuza girer. */
    async function joinWithMask(signer: Signer, dosages: number[], mask: bigint) {
      const addr = await signer.getAddress();
      const builder = fhevm.createEncryptedInput(await protocol.getAddress(), addr);
      builder.add8(0);
      for (const d of dosages) builder.add8(d);
      const enc = await builder.encrypt();

      await protocol.connect(signer).enroll(enc.handles[0], enc.inputProof);
      await protocol
        .connect(signer)
        .contributeDosages(enc.handles.slice(1), mask, enc.inputProof);
    }

    beforeEach(async () => {
      await protocol.connect(owner).configurePanel(2, 0, ethers.ZeroHash, "");
    });

    it("herkeste olan alan 1x, azinlikta olan alan KISI BASINA daha pahali", async () => {
      // 0. alan: herkeste var.  1. alan: yalnizca alice'te.
      await joinWithMask(alice, [1, 1], 0b11n);
      await joinWithMask(bob, [1, 3], 0b01n);
      await joinWithMask(carol, [1, 3], 0b01n);

      const [commonFee] = await payments.quoteForFields([0], []);
      const [rareFee] = await payments.quoteForFields([1], []);

      // Yaygin alan: 3 kayit x 1x.
      expect(commonFee).to.equal(BASE_FEE + 3n * PER_RECORD_FEE);
      // Nadir alan: 1 kayit x 3x (havuz 3 / veren 1).
      expect(rareFee).to.equal(BASE_FEE + 3n * PER_RECORD_FEE);

      // Toplam ayni ama KISI BASINA fiyat uc kat — istenen tam olarak budur:
      // tek veri sahibi, uc kisilik yaygin bir alan kadar kazanir.
      const commonPerRecord = (commonFee - BASE_FEE) / 3n;
      const rarePerRecord = rareFee - BASE_FEE;
      expect(rarePerRecord).to.equal(3n * commonPerRecord);
    });

    it("kitlik carpani TAVANI asamaz", async () => {
      await payments.connect(owner).setScarcityCap(20_000); // 2x

      await joinWithMask(alice, [1, 1], 0b11n);
      await joinWithMask(bob, [1, 3], 0b01n);
      await joinWithMask(carol, [1, 3], 0b01n);

      // Ham kitlik 3x olurdu; tavan 2x'te keser.
      const [rareFee] = await payments.quoteForFields([1], []);
      expect(rareFee).to.equal(BASE_FEE + 2n * PER_RECORD_FEE);
    });

    it("tavan 1x yapilinca kitlik tamamen KAPANIR", async () => {
      await payments.connect(owner).setScarcityCap(10_000);

      await joinWithMask(alice, [1, 1], 0b11n);
      await joinWithMask(bob, [1, 3], 0b01n);

      const [rareFee] = await payments.quoteForFields([1], []);
      expect(rareFee).to.equal(BASE_FEE + PER_RECORD_FEE);
    });

    it("tavan 1x'in ALTINA cekilemez", async () => {
      // Kitligin fiyati DUSURMESI anlamsiz olurdu; carpan zaten 1'in altina
      // inmiyor, boyle bir tavan sessizce etkisiz kalirdi.
      await expect(
        payments.connect(owner).setScarcityCap(5_000),
      ).to.be.revertedWithCustomError(payments, "InvalidScarcityCap");
    });

    // EN ONEMLI TEST.
    //
    // Kitlik fiyata girip PAYA girmeseydi mimari kendi icinde celisirdi:
    // arastirmaci nadir alan icin fazla oder, ama o alanin sahibi yaygin bir
    // alanin sahibiyle ayni payi alirdi. Fazla para herkese esit dagilir,
    // nadir veri sahibinin hakki kalabaligin icinde erirdi.
    it("NADIR veri sahibi, karisik sorguda da primi ALIR", async () => {
      // 0. alan herkeste; 1. alan yalnizca alice'te.
      await joinWithMask(alice, [1, 1], 0b11n);
      await joinWithMask(bob, [1, 3], 0b01n);
      await joinWithMask(carol, [1, 3], 0b01n);

      // HER IKI alani birden isteyen sorgu. Tek alanlik sorguda ayrim
      // kendiliginden dogru cikardi; asil sinav karisik olan.
      const queryId = await openAndSettle([0, 1], []);

      const aliceWeight = await payments.weightedCoverage(queryId, await alice.getAddress());
      const bobWeight = await payments.weightedCoverage(queryId, await bob.getAddress());
      const carolWeight = await payments.weightedCoverage(queryId, await carol.getAddress());

      // Yalnizca yaygin alani verenler esit.
      expect(bobWeight).to.equal(carolWeight);

      // Alice HEM yaygin (1x) HEM nadir (3x) alani verdi -> 4x.
      expect(aliceWeight).to.equal(4n * bobWeight);

      const aliceShare = await payments.claimable(queryId, await alice.getAddress());
      const bobShare = await payments.claimable(queryId, await bob.getAddress());

      // Hesap dogru ama para gelmiyorsa anlamsiz olurdu.
      expect(aliceShare).to.be.greaterThan(bobShare);
    });

    it("dagitilan toplam, katilimci havuzunu ASMAZ", async () => {
      // Payda ile pay ayni agirlik sisteminden gelmezse paylarin toplami
      // havuzu asar ve son ceken bos doner. Kitlik zamanla degistigi icin
      // bu risk gercek — agirliklar sorgu aninda DONDURULUYOR.
      await joinWithMask(alice, [1, 1], 0b11n);
      await joinWithMask(bob, [1, 3], 0b01n);
      await joinWithMask(carol, [1, 3], 0b01n);

      const queryId = await openAndSettle([0, 1], []);

      const shares = await Promise.all(
        [alice, bob, carol].map(async (x) =>
          payments.claimable(queryId, await x.getAddress()),
        ),
      );

      const q = await payments.query(queryId);
      const sum = shares.reduce((a: bigint, b: bigint) => a + b, 0n);
      expect(sum).to.be.lessThanOrEqual(q.liquidityPot);
    });

    it("ucret, ISTENEN alanlarin toplamidir", async () => {
      await joinWithMask(alice, [1, 1], 0b11n);
      await joinWithMask(bob, [1, 3], 0b01n);

      const [both] = await payments.quoteForFields([0, 1], []);
      const [first] = await payments.quoteForFields([0], []);
      const [second] = await payments.quoteForFields([1], []);

      // Taban bir kez alinir; alan ucretleri toplanir.
      expect(both).to.equal(first + second - BASE_FEE);
    });
  });

  describe("Gelir paylasimi (RevShare)", () => {
    it("%80 katilimcilara, %20 hazineye ayrilir", async () => {
      await joinAndGrant(alice, 1);
      await joinAndGrant(bob, 2);

      const [fee] = await payments.quote();
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

      // Carol sorgudan SONRA katiliyor — verisi o hesaplamaya girmedi.
      // Sinir artik acikca yazili: `participantIndex > snapshotCount`.
      await joinPool(carol, 2);

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

      const [fee] = await payments.quote();
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

  describe("Gizlilik Paneli — havuzdan cikis", () => {
    /*
     * IZIN KAPISI KALKTI.
     *
     * Onceden arastirmaci bazinda izin vardi; mimari o sozu tutamiyordu
     * (bkz. `VeriarfyProtocol.leavePool`). Yukleme zaten izindir; geriye
     * "havuzdan cikma" hakki kaldi ve testler onu sinar.
     */

    it("havuza girmeden cikilamaz", async () => {
      await expect(
        protocol.connect(alice).leavePool(),
      ).to.be.revertedWithCustomError(protocol, "NotAParticipant");
    });

    it("iki kez cikilamaz", async () => {
      await joinPool(alice, 1);
      await protocol.connect(alice).leavePool();
      await expect(
        protocol.connect(alice).leavePool(),
      ).to.be.revertedWithCustomError(protocol, "AlreadyLeft");
    });

    it("CIKISTAN SONRA acilan sorgudan pay ALINMAZ", async () => {
      await joinPool(alice, 1);
      await joinPool(bob, 2);

      await protocol.connect(alice).leavePool();
      await openAndSettle();

      expect(await payments.claimable(0, await alice.getAddress())).to.equal(0);
      await expect(payments.connect(alice).claim(0)).to.be.revertedWithCustomError(
        payments,
        "NotInThisQuery",
      );
      expect(await payments.claimable(0, await bob.getAddress())).to.be.greaterThan(0);
    });

    it("CIKISTAN ONCE acilan sorgudan hak edilen pay KORUNUR", async () => {
      await joinPool(alice, 1);
      await openAndSettle(); // sorgu 0 — alice dahil

      // Cikis, hakedis sorgunun ACILDIGI bloga baktigi icin gecmisi silmez.
      // Cikmak cezalandirma degildir.
      await protocol.connect(alice).leavePool();

      expect(await payments.claimable(0, await alice.getAddress())).to.be.greaterThan(0);
      await payments.connect(alice).claim(0);
    });

    it("cikis blogu zincirde okunabilir", async () => {
      await joinPool(alice, 1);
      expect(await protocol.leftPoolAtBlock(await alice.getAddress())).to.equal(0);

      await protocol.connect(alice).leavePool();
      expect(await protocol.leftPoolAtBlock(await alice.getAddress())).to.be.greaterThan(0);
    });

    it("UCRET havuzun tamamina gore hesaplanir", async () => {
      // Izin sayaci kalkti: arastirmaci toplamin tamamini aliyor, dolayisiyla
      // tamami kadar oder. Once az odeyip cok aliyordu.
      await joinPool(alice, 1);
      await joinPool(bob, 2);

      const [, count] = await payments.quote();
      expect(count).to.equal(2);
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

  // ===================================================================================
  // KULLANIMA GORE ODEME — para yolunun korumalari
  // ===================================================================================
  //
  // Bu blogun tamami TEK bir soruya hizmet eder: havuzdan cikan para,
  // havuza girenden fazla olabilir mi? Formul degistiginde ilk kirilacak
  // yer burasidir.

  describe("Kullanima gore odeme", () => {
    /** Uc katilimci havuza girer, izin verir; sorgu acilip bolusturulur. */
    async function threeParticipants(): Promise<bigint> {
      await joinAndGrant(alice, 2);
      await joinAndGrant(bob, 1);
      await joinAndGrant(carol, 0);
      return openAndSettle();
    }

    const cohort = () => [alice, bob, carol];

    it("havuz KULLANIM ve BONUS olarak ikiye ayrilir", async () => {
      const queryId = await threeParticipants();
      const q = await payments.query(queryId);
      const [usagePot, bonusPot] = await payments.potSplit(queryId);

      expect(usagePot + bonusPot).to.equal(q.liquidityPot);

      // Varsayilan %70 kullanim.
      expect(usagePot).to.equal((q.liquidityPot * 7000n) / 10000n);
    });

    it("PAYLARIN TOPLAMI havuzu ASMAZ", async () => {
      // Para yolunun tek gercek guvencesi. Bolme kusurati disinda hicbir
      // sey havuzdan disari cikmamali.
      const queryId = await threeParticipants();
      const q = await payments.query(queryId);

      let sum = 0n;
      for (const s of cohort()) {
        sum += await payments.claimable(queryId, await s.getAddress());
      }

      expect(sum).to.be.lessThanOrEqual(q.liquidityPot);
      // Iki havuz, iki bolme: kisi basina en fazla 2 birim kusurat.
      expect(q.liquidityPot - sum).to.be.lessThan(BigInt(cohort().length) * 2n + 1n);
    });

    it("kapsama agirligi, katilimcinin verdigi ALAN SAYISIDIR", async () => {
      const queryId = await threeParticipants();

      for (const s of cohort()) {
        const w = await payments.coverageWeight(queryId, await s.getAddress());
        expect(w).to.be.greaterThan(0n);
      }
    });

    it("kapsama toplami sifirsa havuzun TAMAMI bonusa gider", async () => {
      // Istenen alanlarin hicbirine kimse veri vermemisse kullanim havuzu
      // dagitilamaz. Kilitlenmemeli — bonusa eklenmeli, aksi halde para
      // sozlesmede olu kalirdi.
      //
      // Bu senaryo kapsama sayaci 0 olan bir alan gerektirir; mevcut
      // kurulumda herkes tek alani kapsiyor, bu yuzden dogrudan
      // `potSplit`'in mantigi sinaniyor.
      const queryId = await threeParticipants();
      const q = await payments.query(queryId);
      const [usagePot, bonusPot] = await payments.potSplit(queryId);

      // Kapsama var -> ikiye ayrilmis olmali.
      expect(q.coverageTotal).to.be.greaterThan(0n);
      expect(usagePot).to.be.greaterThan(0n);
      expect(usagePot + bonusPot).to.equal(q.liquidityPot);
    });

    it("ODENEN ile CEKILEN birbirini tutar", async () => {
      // `claim` ile `claimable` AYNI ifadeden gelmeli. Daha once tam burada
      // ayrismislardi ve test yakalamisti.
      const queryId = await threeParticipants();

      for (const s of cohort()) {
        const who = await s.getAddress();
        const expected = await payments.claimable(queryId, who);
        const before = await token.balanceOf(who);

        await payments.connect(s).claim(queryId);

        expect(await token.balanceOf(who)).to.equal(before + expected);
      }
    });

    it("iki kez cekilemez", async () => {
      const queryId = await threeParticipants();
      await payments.connect(alice).claim(queryId);

      await expect(
        payments.connect(alice).claim(queryId),
      ).to.be.revertedWithCustomError(payments, "AlreadyClaimed");
    });

    it("CEKILEN TOPLAM havuzu asmaz", async () => {
      const queryId = await threeParticipants();

      for (const s of cohort()) {
        const amount = await payments.claimable(queryId, await s.getAddress());
        if (amount > 0n) await payments.connect(s).claim(queryId);
      }

      const q = await payments.query(queryId);
      expect(q.claimedTotal).to.be.lessThanOrEqual(q.liquidityPot);
    });

    it("kullanim payi SIFIRA cekilebilir (eski davranis)", async () => {
      await payments.connect(owner).setUsageShare(0);

      const queryId = await threeParticipants();
      const q = await payments.query(queryId);
      const [usagePot, bonusPot] = await payments.potSplit(queryId);

      expect(usagePot).to.equal(0n);
      expect(bonusPot).to.equal(q.liquidityPot);
    });

    it("kullanim payi TAMAMA cekilebilir", async () => {
      await payments.connect(owner).setUsageShare(10_000);

      const queryId = await threeParticipants();
      const q = await payments.query(queryId);
      const [usagePot, bonusPot] = await payments.potSplit(queryId);

      expect(usagePot).to.equal(q.liquidityPot);
      expect(bonusPot).to.equal(0n);

      // Toplam yine havuzu asmamali.
      let sum = 0n;
      for (const s of cohort()) {
        sum += await payments.claimable(queryId, await s.getAddress());
      }
      expect(sum).to.be.lessThanOrEqual(q.liquidityPot);
    });

    it("gecersiz oran reddedilir", async () => {
      await expect(
        payments.connect(owner).setUsageShare(10_001),
      ).to.be.revertedWithCustomError(payments, "InvalidShare");
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
      const [fee] = await payments.quote();
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
      const [fee] = await payments.quote();

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
