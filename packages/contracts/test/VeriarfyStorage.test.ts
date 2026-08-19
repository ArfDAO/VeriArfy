import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { Signer } from "ethers";

/**
 * Filecoin kalicilik defteri — rapor §2.9.2 ve WBS 2.3.
 *
 * Testlerin yanitladigi sorular:
 *
 *   - Tek bir madenciye 3 anlasma yapip "3 replika" gosterilebiliyor mu?
 *     (gosterilememeli — cogaltmanin amaci tek nokta hatasini kaldirmak)
 *   - 180 gunden kisa anlasma kabul ediliyor mu?  (edilmemeli)
 *   - Ayni anlasma iki kez sayilabiliyor mu?      (sayilamamali)
 *   - Yenileme, veri KAYBOLDUKTAN sonra mi tetikleniyor? (once tetiklenmeli)
 *   - Epoch hesabi bir oracle'a bagimli mi?       (olmamali)
 *
 * Epoch aritmetigi zincirde `block.timestamp`'ten turetildigi icin testler
 * zamani gercekten ilerletir; uydurulmus bir "guncel epoch" degeri YOKTUR.
 */
describe("VeriarfyStorage — Filecoin kaliciligi (rapor §2.9.2)", () => {
  let owner: Signer;
  let attestor: Signer;
  let outsider: Signer;

  let storage: any;

  /** Filecoin ana ag genesis: 24 Agustos 2020, 22:00 UTC. */
  const FILECOIN_GENESIS = 1_598_306_400n;
  const EPOCH_SECONDS = 30n;
  const MIN_DEAL_EPOCHS = 518_400n; // 180 gun
  const RENEWAL_WINDOW = 86_400n; // 30 gun

  const CID_A = ethers.keccak256(ethers.toUtf8Bytes("sifreli-panel-blobu-A"));
  const CID_B = ethers.keccak256(ethers.toUtf8Bytes("sifreli-panel-blobu-B"));
  const PIECE = ethers.keccak256(ethers.toUtf8Bytes("commP"));

  beforeEach(async () => {
    [owner, attestor, outsider] = await ethers.getSigners();

    const Storage = await ethers.getContractFactory("VeriarfyStorage");
    storage = await Storage.deploy(await owner.getAddress(), FILECOIN_GENESIS);
    await storage.waitForDeployment();

    await storage.connect(owner).setAttestor(await attestor.getAddress());
  });

  /** Zincirin su anki blok zamanindan Filecoin epoch'unu hesaplar. */
  async function nowEpoch(): Promise<bigint> {
    return (BigInt(await time.latest()) - FILECOIN_GENESIS) / EPOCH_SECONDS;
  }

  /** Gecerli sureli bir anlasma kaydeder. */
  async function register(
    cid: string,
    providerId: number,
    dealId: number,
    extraEpochs = 0n,
  ) {
    const start = await nowEpoch();
    const end = start + MIN_DEAL_EPOCHS + extraEpochs;
    await storage
      .connect(attestor)
      .registerDeal(cid, providerId, dealId, start, end, PIECE);
    return { start, end };
  }

  // ===================================================================================
  // 1) Epoch — oracle yok
  // ===================================================================================

  describe("Filecoin epoch'u zincirde turetiliyor", () => {
    it("guncel epoch blok zamanindan hesaplaniyor — tanik beyani YOK", async () => {
      const expected = await nowEpoch();
      const actual = await storage.currentEpoch();

      // Blok zamani testler arasinda birkac saniye kayabilir; 2 epoch tolerans.
      expect(actual).to.be.closeTo(expected, 2n);
    });

    it("zaman ilerledikce epoch da ilerliyor", async () => {
      const before = await storage.currentEpoch();
      await time.increase(3_600); // 1 saat = 120 epoch
      const after = await storage.currentEpoch();

      expect(after - before).to.be.closeTo(120n, 2n);
    });
  });

  // ===================================================================================
  // 2) Politika — WBS 2.3 kurallari
  // ===================================================================================

  describe("Cogaltma politikasi (WBS 2.3)", () => {
    it("TEK madenciye 3 anlasma '3 replika' SAYILMAZ", async () => {
      // Cogaltmanin amaci tek nokta hatasini kaldirmaktir. Ayni saglayiciya
      // uc anlasma yapmak bu amaci hicbir sekilde karsilamaz.
      await register(CID_A, 1001, 1);

      await expect(
        register(CID_A, 1001, 2),
      ).to.be.revertedWithCustomError(storage, "ProviderAlreadyStores");
    });

    it("3 FARKLI saglayici kurali saglar", async () => {
      await register(CID_A, 1001, 1);
      expect(await storage.isAdequatelyReplicated(CID_A)).to.equal(false);

      await register(CID_A, 1002, 2);
      expect(await storage.isAdequatelyReplicated(CID_A)).to.equal(false);

      await register(CID_A, 1003, 3);
      expect(await storage.isAdequatelyReplicated(CID_A)).to.equal(true);
      expect(await storage.activeReplicas(CID_A)).to.equal(3);
    });

    it("180 gunden kisa anlasma reddedilir", async () => {
      const start = await nowEpoch();
      await expect(
        storage
          .connect(attestor)
          .registerDeal(CID_A, 1001, 1, start, start + MIN_DEAL_EPOCHS - 1n, PIECE),
      ).to.be.revertedWithCustomError(storage, "DealTooShort");
    });

    it("tam 180 gun kabul edilir", async () => {
      const start = await nowEpoch();
      await expect(
        storage
          .connect(attestor)
          .registerDeal(CID_A, 1001, 1, start, start + MIN_DEAL_EPOCHS, PIECE),
      ).to.not.be.reverted;
    });

    it("ayni anlasma numarasi iki kez kaydedilemez", async () => {
      await register(CID_A, 1001, 7);
      await expect(
        storage
          .connect(attestor)
          .registerDeal(CID_B, 1002, 7, await nowEpoch(), (await nowEpoch()) + MIN_DEAL_EPOCHS, PIECE),
      ).to.be.revertedWithCustomError(storage, "DealAlreadyRegistered");
    });

    it("bitis baslangictan once olamaz", async () => {
      const start = await nowEpoch();
      await expect(
        storage.connect(attestor).registerDeal(CID_A, 1001, 1, start, start - 1n, PIECE),
      ).to.be.revertedWithCustomError(storage, "EndBeforeStart");
    });

    it("bos CID reddedilir", async () => {
      const start = await nowEpoch();
      await expect(
        storage
          .connect(attestor)
          .registerDeal(ethers.ZeroHash, 1001, 1, start, start + MIN_DEAL_EPOCHS, PIECE),
      ).to.be.revertedWithCustomError(storage, "EmptyCid");
    });

    it("tanik olmayan anlasma kaydedemez", async () => {
      const start = await nowEpoch();
      await expect(
        storage
          .connect(outsider)
          .registerDeal(CID_A, 1001, 1, start, start + MIN_DEAL_EPOCHS, PIECE),
      ).to.be.revertedWithCustomError(storage, "NotAttestor");
    });
  });

  // ===================================================================================
  // 3) Suresi dolan ve dusen anlasmalar
  // ===================================================================================

  describe("Suresi dolma ve dusme", () => {
    it("suresi dolan anlasma aktif SAYILMAZ", async () => {
      await register(CID_A, 1001, 1);
      await register(CID_A, 1002, 2);
      await register(CID_A, 1003, 3);
      expect(await storage.isAdequatelyReplicated(CID_A)).to.equal(true);

      // 181 gun ilerlet — hepsi biter.
      await time.increase(181 * 24 * 3_600);

      expect(await storage.activeReplicas(CID_A)).to.equal(0);
      expect(await storage.isAdequatelyReplicated(CID_A)).to.equal(false);
    });

    it("dusen anlasma isaretlenir ama SILINMEZ", async () => {
      // Silinseydi bir saglayicinin gecmiste basarisiz oldugu bilgisi
      // kaybolurdu.
      await register(CID_A, 1001, 1);
      await register(CID_A, 1002, 2);
      await register(CID_A, 1003, 3);

      await expect(storage.connect(attestor).terminateDeal(2, "sektor dusuruldu"))
        .to.emit(storage, "DealTerminated")
        .withArgs(CID_A, 2, "sektor dusuruldu");

      expect(await storage.dealCount(CID_A)).to.equal(3); // kayit duruyor
      expect(await storage.activeReplicas(CID_A)).to.equal(2); // ama sayilmiyor

      const deal = await storage.dealAt(CID_A, 1);
      expect(deal.terminated).to.equal(true);
    });

    it("dusen anlasmadan sonra AYNI saglayiciyla yeniden anlasilabilir", async () => {
      await register(CID_A, 1001, 1);
      await storage.connect(attestor).terminateDeal(1, "gecici ariza");

      // Kilit acilmali; aksi halde bir kez dusen saglayici kalici olarak
      // dislanirdi ve bu bir politika karari degil, kaza olurdu.
      await expect(register(CID_A, 1001, 2)).to.not.be.reverted;
      expect(await storage.activeReplicas(CID_A)).to.equal(1);
    });

    it("esik altina dusunce RenewalRequired yayilir", async () => {
      await register(CID_A, 1001, 1);
      await register(CID_A, 1002, 2);
      await register(CID_A, 1003, 3);

      await expect(storage.connect(attestor).terminateDeal(3, "cezalandirildi"))
        .to.emit(storage, "RenewalRequired");
    });

    it("ayni anlasma iki kez dusurulemez", async () => {
      await register(CID_A, 1001, 1);
      await storage.connect(attestor).terminateDeal(1, "ariza");
      await expect(
        storage.connect(attestor).terminateDeal(1, "tekrar"),
      ).to.be.revertedWithCustomError(storage, "DealAlreadyTerminated");
    });

    it("bilinmeyen anlasma dusurulemez", async () => {
      await expect(
        storage.connect(attestor).terminateDeal(999, "yok"),
      ).to.be.revertedWithCustomError(storage, "UnknownDeal");
    });
  });

  // ===================================================================================
  // 4) Otomatik yenileme (WBS 2.3)
  // ===================================================================================

  describe("Otomatik yenileme", () => {
    it("yenileme, veri KAYBOLMADAN once tetiklenir", async () => {
      // Anlasma bitene kadar beklemek gec olurdu: yeni anlasma kurmak,
      // veriyi aktarmak ve sektoru muhurlemek zaman alir.
      await register(CID_A, 1001, 1);
      await register(CID_A, 1002, 2);
      await register(CID_A, 1003, 3);

      expect(await storage.renewalDue(CID_A)).to.equal(false);

      // 180 - 30 = 150 gun sonra yenileme penceresine girilir.
      await time.increase(151 * 24 * 3_600);

      expect(await storage.renewalDue(CID_A)).to.equal(true);
      // Kritik: veri hala yerinde, kaybolmus DEGIL.
      expect(await storage.isAdequatelyReplicated(CID_A)).to.equal(true);
    });

    it("replika esigin altindaysa yenileme gerekir", async () => {
      await register(CID_A, 1001, 1);
      await register(CID_A, 1002, 2);
      expect(await storage.renewalDue(CID_A)).to.equal(true);
    });

    it("hic anlasmasi olmayan CID icin yenileme 'gerekmez'", async () => {
      // Kaydi olmayan bir CID bu defterin konusu degildir; her okumada
      // olay yaymak gurultu olurdu.
      expect(await storage.renewalDue(CID_B)).to.equal(false);
    });

    it("flagRenewal herkese acik ama yalnizca GEREKIYORSA olay yayar", async () => {
      await register(CID_A, 1001, 1);
      await register(CID_A, 1002, 2);
      await register(CID_A, 1003, 3);

      // Gerek yokken sessiz.
      await expect(storage.connect(outsider).flagRenewal(CID_A)).to.not.emit(
        storage, "RenewalRequired",
      );

      await time.increase(151 * 24 * 3_600);

      // Gerektiginde herkes tetikleyebilir — tek bir tarafin insafina
      // birakilmamalidir.
      await expect(storage.connect(outsider).flagRenewal(CID_A)).to.emit(
        storage, "RenewalRequired",
      );
    });

    it("yenileme sonrasi durum duzelir", async () => {
      await register(CID_A, 1001, 1);
      await register(CID_A, 1002, 2);
      await register(CID_A, 1003, 3);
      await time.increase(151 * 24 * 3_600);
      expect(await storage.renewalDue(CID_A)).to.equal(true);

      // Uc anlasma da uzun sureli yenileriyle degistirilir.
      for (const [i, provider] of [1001, 1002, 1003].entries()) {
        await storage.connect(attestor).terminateDeal(i + 1, "yenileniyor");
        await register(CID_A, provider, 10 + i, MIN_DEAL_EPOCHS);
      }

      expect(await storage.activeReplicas(CID_A)).to.equal(3);
      expect(await storage.renewalDue(CID_A)).to.equal(false);
    });
  });

  // ===================================================================================
  // 5) Ozet okuma
  // ===================================================================================

  describe("Panel ozeti", () => {
    it("persistenceStatus dogru ozet veriyor", async () => {
      const { end: firstEnd } = await register(CID_A, 1001, 1);
      await register(CID_A, 1002, 2, MIN_DEAL_EPOCHS);
      await register(CID_A, 1003, 3, MIN_DEAL_EPOCHS);

      const [replicas, adequate, due, earliest] =
        await storage.persistenceStatus(CID_A);

      expect(replicas).to.equal(3);
      expect(adequate).to.equal(true);
      expect(due).to.equal(false);
      // En erken biten, en kisa sureli olan.
      expect(earliest).to.be.closeTo(firstEnd, 2n);
    });

    it("izlenen CID sayisi yalnizca ILK anlasmada artar", async () => {
      expect(await storage.trackedCidCount()).to.equal(0);

      await register(CID_A, 1001, 1);
      expect(await storage.trackedCidCount()).to.equal(1);

      await register(CID_A, 1002, 2);
      expect(await storage.trackedCidCount()).to.equal(1); // ayni CID

      await register(CID_B, 1001, 3);
      expect(await storage.trackedCidCount()).to.equal(2);
    });

    it("dealsOf tum anlasmalari dondurur — dogrulama betigi bunu okur", async () => {
      await register(CID_A, 1001, 11);
      await register(CID_A, 1002, 12);

      const deals = await storage.dealsOf(CID_A);
      expect(deals.length).to.equal(2);
      expect(deals[0].dealId).to.equal(11);
      expect(deals[1].providerId).to.equal(1002);
    });
  });
});
