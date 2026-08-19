import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import type { Signer } from "ethers";
import { protocolFactory } from "./helpers/factories";

/**
 * Nadirlik Carpani — rapor §4.3.
 *
 * Raporun iddiasi su: nadir bir varyanti tasiyan kisinin verisi daha
 * degerlidir ve bu deger, verinin KENDISI ACILMADAN odemeye yansimalidir.
 * Mekanizma uc parcadir:
 *
 *   1. Sifreli tek bit:  `ebool = FHE.eq(dozaj, nadir_kod)`
 *   2. Esikli cozum:     KMS dugumleri YALNIZCA bu biti cozer
 *   3. Carpan:           R = log2(1 + N_havuz / N_tasiyici)
 *
 * Ayrica ilk 10.000 saglayici "Kurucu Katkici" sayilir ve kalici +%50 alir.
 *
 * BU DOSYADA HICBIR ADIM TAKLIT EDILMEZ: sifreleme gercek FHE, cozum gercek
 * KMS esigi, cozumun dogrulanmasi zincirdeki gercek `KMSVerifier`
 * sozlesmesidir. "Nadir tasiyici" isaretini kimse elle atayamaz.
 */
describe("Nadirlik Carpani (rapor §4.3)", () => {
  let owner: Signer;
  let researcher: Signer;
  let alice: Signer;
  let bob: Signer;
  let carol: Signer;
  let nodeA: Signer;
  let nodeB: Signer;

  let token: any;
  let protocol: any;
  let payments: any;
  let registry: any;
  let math: any;

  const CIRCUITS = join(__dirname, "..", "..", "circuits");
  const IDENTITY_WASM = join(
    CIRCUITS, "build", "researcher_identity_js", "researcher_identity.wasm",
  );
  const IDENTITY_ZKEY = join(CIRCUITS, "build", "researcher_identity_final.zkey");
  const PROVENANCE_ZKEY = join(CIRCUITS, "build", "data_provenance_final.zkey");

  const BASE_FEE = 10_000_000n;
  const PER_PARTICIPANT_FEE = 1_000_000n;
  const LIQUIDITY_SHARE_BPS = 8_000;
  const STATISTICS = 4;
  const ALL_TYPES = 1 | 2 | 4;

  let circuits: any;
  let provenanceLib: any;
  let snarkjs: any;
  let institutionRegistry: any;

  before(async () => {
    if (!existsSync(PROVENANCE_ZKEY) || !existsSync(IDENTITY_ZKEY)) {
      throw new Error("Devre ciktilari yok. Once `npm run circuits:build` calistirin.");
    }
    circuits = await import("@veriarfy/circuits");
    provenanceLib = await import("@veriarfy/circuits/provenance");
    snarkjs = await import("snarkjs");
    ({ registry: institutionRegistry } = await provenanceLib.developmentRegistry());
  });

  beforeEach(async () => {
    [owner, researcher, alice, bob, carol, nodeA, nodeB] = await ethers.getSigners();

    const Math_ = await ethers.getContractFactory("RarityMathHarness");
    math = await Math_.deploy();
    await math.waitForDeployment();

    const Token = await ethers.getContractFactory("StableTestToken");
    token = await Token.deploy(await owner.getAddress());
    await token.waitForDeployment();

    // --- Arastirmaci kimligi (gercek Groth16) ----------------------------
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
    const { proof } = await snarkjs.groth16.fullProve(
      identityInput, IDENTITY_WASM, IDENTITY_ZKEY,
    );
    const cd = circuits.toSolidityCalldata(proof);
    await registry
      .connect(researcher)
      .register(
        identityTree.root,
        circuits.computeNullifierHash(1n, identity.nullifier),
        cd.a, cd.b, cd.c,
      );

    // --- Protokol + odemeler ---------------------------------------------
    const ProvVerifier = await ethers.getContractFactory("DataProvenanceVerifier");
    const provVerifier = await ProvVerifier.deploy();
    await provVerifier.waitForDeployment();

    const Protocol = await protocolFactory();
    protocol = await Protocol.deploy(
      await owner.getAddress(), 2, 1,
      await provVerifier.getAddress(),
      institutionRegistry.root,
    );
    await protocol.waitForDeployment();

    for (const node of [nodeA, nodeB]) {
      await protocol.connect(owner).authorizeNode(await node.getAddress());
    }

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
    await protocol.connect(owner).setQueryGateway(await payments.getAddress());

    await token.connect(owner).mint(await researcher.getAddress(), 1_000_000_000n);
    await token
      .connect(researcher)
      .approve(await payments.getAddress(), ethers.MaxUint256);
  });

  /** Havuza gercek FHE sifrelemesiyle katilir. */
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
   * Nadirlik degerlendirmesini bastan sona yurutur.
   *
   * Rapor §4.3'teki akisin birebir karsiligi:
   *   katilimci acilima izin verir -> KMS esigi TEK BITI cozer ->
   *   sonuc ve imzalar zincire yazilir -> zincir imzalari dogrular.
   */
  async function assessRarity(signer: Signer) {
    await protocol.connect(signer).requestRarityAssessment();
    const handle = await protocol.rarityHandle(await signer.getAddress());

    // Gercek esikli cozum: duz deger + KMS dugumlerinin EIP-712 imzalari.
    const result = await fhevm.publicDecrypt([handle]);

    await protocol.confirmRarity(
      await signer.getAddress(),
      result.abiEncodedClearValues,
      result.decryptionProof,
    );
    return handle;
  }

  async function grant(participant: Signer) {
    await protocol
      .connect(participant)
      .grantAccess(await researcher.getAddress(), ALL_TYPES, 0, 0);
  }

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

  // ===================================================================================
  // 1) Formul — raporun kendi ornegi
  // ===================================================================================

  describe("Carpan formulu: R = log2(1 + N/C)", () => {
    it("raporun 100.000 kisilik ornegi ~11x veriyor", async () => {
      // Rapor §4.3: "100.000 kisilik havuzda yalnizca 50 kisi tasiyorsa
      // R = log2(2001) ~= 11".
      const r = await math.multiplierBps(100_000, 50);

      // log2(2001) = 10,96682... -> 109.668 bps. Sabit noktali uygulamanin
      // birkac baz puanlik sapmasi kabul edilir; rapor "yaklasik 11" diyor.
      expect(r).to.be.closeTo(109_668n, 5n);
    });

    it("herkes tasiyorsa prim YOKTUR — R tam olarak 1,00x", async () => {
      // N = C -> log2(1 + 1) = 1. Nadir olmayan bir sey nadir sayilamaz;
      // formulun kendisi bu tabana oturur.
      expect(await math.multiplierBps(500, 500)).to.equal(10_000n);
    });

    it("carpan seyreklikle birlikte artar (monotonluk)", async () => {
      const pool = 100_000;
      const values: bigint[] = [];
      for (const carriers of [50_000, 10_000, 1_000, 100, 10, 1]) {
        values.push(await math.multiplierBps(pool, carriers));
      }
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).to.be.greaterThan(values[i - 1]);
      }
      // Tek tasiyici: log2(100.001) ~= 16,6.
      expect(values[values.length - 1]).to.be.closeTo(166_096n, 10n);
    });

    it("tasiyici yoksa carpan tanimsizdir ve 0 doner", async () => {
      // Sifira bolme yerine 0: cagiran taraf bu terimi zaten toplama katmaz.
      expect(await math.multiplierBps(1_000, 0)).to.equal(0n);
    });

    it("kesirli kisim gercekten hesaplaniyor — tam sayi log2 DEGIL", async () => {
      // Tam sayi log2 kullanilsaydi bu iki havuz ayni carpani alirdi
      // (floor(log2(2001)) = floor(log2(3001)) = 10). Kesirli kisim olmadan
      // formul, 2.000 ile 4.095 arasindaki her seyrekligi ayni sayar.
      const a = await math.multiplierBps(100_000, 50); // 1 + 2000
      const b = await math.multiplierBps(150_000, 50); // 1 + 3000
      expect(b).to.be.greaterThan(a);
      expect(b - a).to.be.greaterThan(1_000n); // ~0,58 bit fark
    });

    it("Kurucu Katkici bonusu tam olarak +%50", async () => {
      expect(await math.withFoundingBonus(10_000n)).to.equal(15_000n);
      expect(await math.withFoundingBonus(109_668n)).to.equal(164_502n);
    });
  });

  // ===================================================================================
  // 2) Sifreli tespit — bit acilmadan once
  // ===================================================================================

  describe("Sifreli tespit ve esikli cozum", () => {
    it("degerlendirme istenmeden nadirlik durumu YOKTUR", async () => {
      await joinPool(alice, 2);

      // Havuza girmek biti acmaz. Varsayilan gizliliktir.
      expect(await protocol.rarityRequested(await alice.getAddress())).to.equal(false);
      expect(await protocol.isRareCarrier(await alice.getAddress())).to.equal(false);
      expect(await protocol.rareCarrierCount()).to.equal(0);
    });

    it("degerlendirme istenmeden sonuc yazilamaz", async () => {
      await joinPool(alice, 2);
      await expect(
        protocol.confirmRarity(await alice.getAddress(), "0x", "0x"),
      ).to.be.revertedWithCustomError(protocol, "RarityNotRequested");
    });

    it("havuza girmeyen degerlendirme isteyemez", async () => {
      await expect(
        protocol.connect(alice).requestRarityAssessment(),
      ).to.be.revertedWithCustomError(protocol, "NotAParticipant");
    });

    it("KMS esigi dozaj 2'yi nadir, 1 ve 0'i degil olarak cozer", async () => {
      await joinPool(alice, 2); // homozigot mutant -> nadir
      await joinPool(bob, 1);   // heterozigot     -> nadir DEGIL
      await joinPool(carol, 0); // referans        -> nadir DEGIL

      for (const s of [alice, bob, carol]) await assessRarity(s);

      expect(await protocol.isRareCarrier(await alice.getAddress())).to.equal(true);
      expect(await protocol.isRareCarrier(await bob.getAddress())).to.equal(false);
      expect(await protocol.isRareCarrier(await carol.getAddress())).to.equal(false);
      expect(await protocol.rareCarrierCount()).to.equal(1);
    });

    it("UYDURULMUS sonuc zincirde reddedilir — imza dogrulamasi tutmaz", async () => {
      // Guvenligin butun agirligi burada: `confirmRarity` herkese aciktir.
      // Acik olmasi zararsizdir CUNKU sonucun KMS esigi tarafindan
      // imzalandigi zincirde dogrulanir.
      await joinPool(bob, 1); // gercekte nadir DEGIL
      await protocol.connect(bob).requestRarityAssessment();

      // Saldirgan "nadirim" demeye calisiyor: duz deger true, kanit yok.
      const fakeResult = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [true]);
      await expect(
        protocol.confirmRarity(await bob.getAddress(), fakeResult, "0x"),
      ).to.be.reverted;

      expect(await protocol.isRareCarrier(await bob.getAddress())).to.equal(false);
    });

    it("BASKASININ gecerli kaniti kendi bitine yapistirilamaz", async () => {
      await joinPool(alice, 2); // gercekten nadir
      await joinPool(bob, 1);   // degil

      const aliceHandle = await assessRarity(alice);
      const aliceProof = await fhevm.publicDecrypt([aliceHandle]);

      await protocol.connect(bob).requestRarityAssessment();

      // Alice'in gercek, gecerli imzali sonucu Bob'a tasiniyor. Imzalar
      // HANDLE'A baglidir; Bob'un handle'i farkli oldugu icin dogrulama tutmaz.
      await expect(
        protocol.confirmRarity(
          await bob.getAddress(),
          aliceProof.abiEncodedClearValues,
          aliceProof.decryptionProof,
        ),
      ).to.be.reverted;

      expect(await protocol.isRareCarrier(await bob.getAddress())).to.equal(false);
    });

    it("ayni bit iki kez dogrulanamaz", async () => {
      await joinPool(alice, 2);
      const handle = await assessRarity(alice);
      const again = await fhevm.publicDecrypt([handle]);

      await expect(
        protocol.confirmRarity(
          await alice.getAddress(),
          again.abiEncodedClearValues,
          again.decryptionProof,
        ),
      ).to.be.revertedWithCustomError(protocol, "RarityAlreadyConfirmed");

      // Sayac da sismez.
      expect(await protocol.rareCarrierCount()).to.equal(1);
    });

    it("degerlendirme iki kez istenemez", async () => {
      await joinPool(alice, 2);
      await protocol.connect(alice).requestRarityAssessment();
      await expect(
        protocol.connect(alice).requestRarityAssessment(),
      ).to.be.revertedWithCustomError(protocol, "RarityAlreadyRequested");
    });

    it("acilan TEK BITTIR — dozaj havuzu hala kapali", async () => {
      await joinPool(alice, 2);
      await assessRarity(alice);

      // Nadirlik biti acildi ama havuzun kendisi acilmadi: onu cozmek hala
      // BSKK-44 esigini gerektirir (rapor §2.6).
      const pool = await protocol.dosagePool();
      await expect(fhevm.publicDecryptEuint(0, pool)).to.be.rejected;
    });
  });

  // ===================================================================================
  // 3) Odemeye yansima
  // ===================================================================================

  describe("Gelir paylasimina yansima", () => {
    it("nadir tasiyici, yaygin tasiyicidan DAHA COK pay alir", async () => {
      await joinPool(alice, 2); // nadir
      await joinPool(bob, 1);
      await joinPool(carol, 0);
      for (const s of [alice, bob, carol]) await assessRarity(s);
      for (const s of [alice, bob, carol]) await grant(s);

      const queryId = await openAndSettle();

      const aliceShare = await payments.claimable(queryId, await alice.getAddress());
      const bobShare = await payments.claimable(queryId, await bob.getAddress());
      const carolShare = await payments.claimable(queryId, await carol.getAddress());

      expect(aliceShare).to.be.greaterThan(bobShare);
      expect(bobShare).to.equal(carolShare); // ikisi de yaygin -> esit

      // 3 kisilik havuzda 1 tasiyici: R = log2(1 + 3/1) = 2,00x tam.
      const [, , multiplier] = await payments.queryWeights(queryId);
      expect(multiplier).to.equal(20_000n);
      // Herkes Kurucu oldugu icin +%50 bonusu sadelesir; oran saf R'dir.
      expect(aliceShare).to.equal(bobShare * 2n);
    });

    it("paylarin toplami havuzu ASMAZ", async () => {
      await joinPool(alice, 2);
      await joinPool(bob, 1);
      await joinPool(carol, 2); // ikinci tasiyici
      for (const s of [alice, bob, carol]) await assessRarity(s);
      for (const s of [alice, bob, carol]) await grant(s);

      const queryId = await openAndSettle();
      const q = await payments.query(queryId);

      let sum = 0n;
      for (const s of [alice, bob, carol]) {
        sum += await payments.claimable(queryId, await s.getAddress());
      }

      expect(sum).to.be.lessThanOrEqual(q.liquidityPot);
      // Artik yalnizca tam sayi bolmesi kusuratidir: kisi basina 1 birimden az.
      expect(q.liquidityPot - sum).to.be.lessThan(3n);
    });

    it("agirliklarin toplami paydayla BIREBIR tutar", async () => {
      await joinPool(alice, 2);
      await joinPool(bob, 1);
      await joinPool(carol, 0);
      for (const s of [alice, bob, carol]) await assessRarity(s);
      for (const s of [alice, bob, carol]) await grant(s);

      const queryId = await openAndSettle();
      const [, , , totalWeight] = await payments.queryWeights(queryId);

      let sum = 0n;
      for (const s of [alice, bob, carol]) {
        sum += await payments.weightOf(queryId, await s.getAddress());
      }
      // Sayaclardan O(1) hesaplanan payda, tek tek toplanan agirliklara esit
      // olmali. Esit degilse dagitim ya havuzu asar ya da para kilitler.
      expect(sum).to.equal(totalWeight);
    });

    it("pay gercekten cekilebiliyor ve carpani tasiyor", async () => {
      await joinPool(alice, 2);
      await joinPool(bob, 1);
      for (const s of [alice, bob]) await assessRarity(s);
      for (const s of [alice, bob]) await grant(s);

      const queryId = await openAndSettle();
      const expected = await payments.claimable(queryId, await alice.getAddress());

      const before = await token.balanceOf(await alice.getAddress());
      await payments.connect(alice).claim(queryId);
      const after = await token.balanceOf(await alice.getAddress());

      expect(after - before).to.equal(expected);
    });

    it("degerlendirme yaptirmayan havuz esit boluse doner (eski davranis)", async () => {
      // Nadirlik ozelligi eski davranisin USTUNE eklenmistir. Kimse
      // degerlendirme istemezse dagitim tam olarak eskisi gibi calisir.
      await joinPool(alice, 2);
      await joinPool(bob, 1);
      for (const s of [alice, bob]) await grant(s);

      const queryId = await openAndSettle();
      const q = await payments.query(queryId);

      const a = await payments.claimable(queryId, await alice.getAddress());
      const b = await payments.claimable(queryId, await bob.getAddress());
      expect(a).to.equal(b);
      expect(a).to.equal(q.liquidityPot / 2n);
    });

    it("izinden SONRA dogrulanan nadirlik eski izne yansimaz", async () => {
      // Payda izin anindaki duruma gore tutulur. Sonradan degisen bir durum
      // paydaya yansimadigi icin bireysel agirliga da yansimamalidir —
      // aksi halde paylarin toplami havuzu asardi.
      await joinPool(alice, 2);
      await joinPool(bob, 1);
      await grant(alice); // once izin
      await grant(bob);
      await assessRarity(alice); // sonra dogrulama
      await assessRarity(bob);

      const queryId = await openAndSettle();
      const a = await payments.claimable(queryId, await alice.getAddress());
      const b = await payments.claimable(queryId, await bob.getAddress());
      expect(a).to.equal(b);

      // Izni yenilerse yeni agirligiyla sayilir.
      await protocol.connect(alice).revokeAccess(await researcher.getAddress());
      await grant(alice);
      const next = await openAndSettle();
      expect(
        await payments.claimable(next, await alice.getAddress()),
      ).to.be.greaterThan(await payments.claimable(next, await bob.getAddress()));
    });

    it("iptal, nadirlik sayaclarini da dogru dusurur", async () => {
      await joinPool(alice, 2);
      await assessRarity(alice);
      await grant(alice);

      const researcherAddr = await researcher.getAddress();
      expect(await protocol.consentRareCount(researcherAddr)).to.equal(1);
      expect(await protocol.consentRareFoundingCount(researcherAddr)).to.equal(1);

      await protocol.connect(alice).revokeAccess(researcherAddr);
      expect(await protocol.consentRareCount(researcherAddr)).to.equal(0);
      expect(await protocol.consentFoundingCount(researcherAddr)).to.equal(0);
      expect(await protocol.consentRareFoundingCount(researcherAddr)).to.equal(0);
    });
  });

  // ===================================================================================
  // 4) Kurucu Katkici
  // ===================================================================================

  describe("Kurucu Katkici (ilk 10.000 saglayici)", () => {
    it("erken katilanlar Kurucu sayilir", async () => {
      await joinPool(alice, 1);
      expect(await protocol.isFoundingContributor(await alice.getAddress()))
        .to.equal(true);
      // Havuza hic girmemis adres Kurucu DEGILDIR — indeks 0 "katilimci degil".
      expect(await protocol.isFoundingContributor(await bob.getAddress()))
        .to.equal(false);
      expect(await protocol.FOUNDING_CONTRIBUTOR_LIMIT()).to.equal(10_000);
    });

    it("carpan, sorgu acildigi anda SABITLENIR", async () => {
      await joinPool(alice, 2);
      await joinPool(bob, 1);
      for (const s of [alice, bob]) await assessRarity(s);
      for (const s of [alice, bob]) await grant(s);

      await payments.connect(researcher).openQuery(STATISTICS);
      const queryId = (await payments.nextQueryId()) - 1n;
      const [poolBefore, carriersBefore, multiplierBefore] =
        await payments.queryWeights(queryId);
      expect(poolBefore).to.equal(2);
      expect(carriersBefore).to.equal(1);

      // Sorgudan SONRA havuz buyuyor — carpan degismemeli, yoksa bu sorgudan
      // alinacak paylar sonradan katilanlara gore kayardi.
      await joinPool(carol, 0);
      await assessRarity(carol);

      const [poolAfter, , multiplierAfter] = await payments.queryWeights(queryId);
      expect(poolAfter).to.equal(2);
      expect(multiplierAfter).to.equal(multiplierBefore);
    });
  });
});
