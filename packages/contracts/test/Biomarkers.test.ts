import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/mock-utils";
import type { Signer } from "ethers";

import { biomarkersFactory, protocolFactory } from "./helpers/factories";

/**
 * Veri kategorisi 2 — surekli biyobelirtec ve fizyolojik telemetri.
 *
 * Genomik tarafta dozaj KATEGORIKTIR (0/1/2) ve dogru arac kontenjans
 * tablosu + ki-karedir. Burada olcumler SUREKLIDIR; soru "vaka grubunun
 * ORTALAMASI kontrol grubundan farkli mi" olur ve testi Welch t-testidir.
 * Zincirde grup basina yalnizca uc sayi birikir: n, Sum x, Sum x^2.
 *
 * Bu dosyanin yanitladigi sorular:
 *
 *   - Toplamlar gercekten dogru mu birikiyor (elle hesaplanan degerle ayni mi)?
 *   - Eksik olcum (0) ortalamayi bozuyor mu?           (bozmamali)
 *   - Arali disi deger sinira KIRPILIYOR mu?           (kirpilmamali, elenmeli)
 *   - Gruplar birbirine karisiyor mu?                  (karismamali)
 *   - Modul tek basina cozum yetkisi verebiliyor mu?   (verememeli)
 *   - Modul kayitlardan SONRA baglanabiliyor mu?       (baglanmamali)
 *
 * Sifreleme her adimda gercek FHE'dir.
 */
describe("Biyobelirtec kanali (veri kategorisi 2)", () => {
  let owner: Signer;
  let researcher: Signer;
  let nodeA: Signer;
  let participants: Signer[];

  let protocol: any;
  let biomarkers: any;
  let protocolAddr: string;
  let moduleAddr: string;

  const SNP_COUNT = 1;
  const STATISTICS = 4;

  /**
   * Kucuk ama gercekci bir panel.
   *
   * Araliklar calismanin ilan ettigi degerlerdir; olcek her metrik icin
   * ayridir cunku dinamik araliklari cok farklidir.
   */
  const METRICS = [
    // VO2 max: 15,0 - 90,0 ml/kg/dk, olcek 100.
    {
      code: ethers.encodeBytes32String("VO2MAX"),
      unit: ethers.encodeBytes32String("ml/kg/min"),
      scale: 100,
      offset: 0,
      minValue: 1500,
      maxValue: 9000,
    },
    // Laktat esigi: 1,00 - 20,00 mmol/L, olcek 1000.
    {
      code: ethers.encodeBytes32String("LACTATE_THRESHOLD"),
      unit: ethers.encodeBytes32String("mmol/L"),
      scale: 1000,
      offset: 0,
      minValue: 1000,
      maxValue: 20000,
    },
  ];

  beforeEach(async () => {
    const signers = await ethers.getSigners();
    [owner, researcher, nodeA] = signers;
    participants = signers.slice(3, 11);

    const ProvVerifier = await ethers.getContractFactory("DataProvenanceVerifier");
    const provVerifier = await ProvVerifier.deploy();
    await provVerifier.waitForDeployment();

    const Protocol = await protocolFactory();
    protocol = await Protocol.deploy(
      await owner.getAddress(),
      1,
      1,
      await provVerifier.getAddress(),
      ethers.ZeroHash,
    );
    await protocol.waitForDeployment();
    protocolAddr = await protocol.getAddress();

    const Biomarkers = await biomarkersFactory();
    biomarkers = await Biomarkers.deploy(protocolAddr);
    await biomarkers.waitForDeployment();
    moduleAddr = await biomarkers.getAddress();

    // SIRA ONEMLI: modul ilk kayittan ONCE baglanmalidir, cunku sifreli grup
    // etiketinin kullanim izni kayit aninda verilir.
    await protocol.connect(owner).setBiomarkerModule(moduleAddr);
    await protocol.connect(owner).configurePanel(SNP_COUNT, 0, ethers.ZeroHash, "");
    await biomarkers
      .connect(owner)
      .configureMetrics(METRICS, ethers.id("metrik-belgesi-v1"), "ipfs://metrics");

    await protocol.connect(owner).authorizeNode(await nodeA.getAddress());
    await protocol.connect(owner).setQueryGateway(await owner.getAddress());
  });

  /** Katilimciyi gruba kaydeder (sifreli) ve genomik panelini tamamlar. */
  async function enroll(signer: Signer, group: number) {
    const enc = await fhevm
      .createEncryptedInput(protocolAddr, await signer.getAddress())
      .add8(group)
      .add8(0)
      .encrypt();
    await protocol.connect(signer).enroll(enc.handles[0], enc.inputProof);
    await protocol.connect(signer).contributeDosages([enc.handles[1]], enc.inputProof);
  }

  /**
   * Olcekli olcumleri gonderir.
   *
   * DIKKAT: girdi kaniti KONTRAT ADRESINE baglidir. Olcumler modulun adresi
   * icin sifrelenir, protokolunki icin degil.
   */
  async function contribute(signer: Signer, values: number[]) {
    const builder = fhevm.createEncryptedInput(moduleAddr, await signer.getAddress());
    for (const v of values) builder.add32(v);
    const enc = await builder.encrypt();

    await biomarkers.connect(signer).contributeBiomarkers(enc.handles, enc.inputProof);
  }

  async function join(signer: Signer, group: number, values: number[]) {
    await enroll(signer, group);
    await contribute(signer, values);
  }

  /** Acilim talebini acar, onaylatir ve yurutur. */
  async function disclose(): Promise<bigint> {
    const id = await protocol.nextRequestId();
    await protocol
      .connect(owner)
      .requestDisclosure(await researcher.getAddress(), STATISTICS);
    await protocol.connect(nodeA).approveDisclosure(id);
    await protocol.executeDisclosure(id);
    return id;
  }

  /** Bir metrigin bir grubundaki toplamlari duz metne cozer. */
  async function readAggregate(requestId: bigint, metric: number, group: number) {
    const [sum, sumSq, count] = await biomarkers.disclosureBiomarkerAt(
      requestId,
      metric,
      group,
    );
    return {
      sum: Number(
        await fhevm.userDecryptEuint(FhevmType.euint64, sum, moduleAddr, researcher),
      ),
      sumSq: Number(
        await fhevm.userDecryptEuint(FhevmType.euint64, sumSq, moduleAddr, researcher),
      ),
      n: Number(
        await fhevm.userDecryptEuint(FhevmType.euint32, count, moduleAddr, researcher),
      ),
    };
  }

  // -------------------------------------------------------------------------
  describe("Toplamlarin dogrulugu", () => {
    it("n, Sum x ve Sum x^2 elle hesaplanan degerlerle birebir ayni", async () => {
      // Kontrol grubu: VO2 max 42,0 ve 48,0 (olcekli 4200 / 4800).
      await join(participants[0], 0, [4200, 12000]);
      await join(participants[1], 0, [4800, 13000]);
      // Vaka grubu: 35,0.
      await join(participants[2], 1, [3500, 11000]);

      const id = await disclose();

      const control = await readAggregate(id, 0, 0);
      expect(control.n).to.equal(2);
      expect(control.sum).to.equal(4200 + 4800);
      expect(control.sumSq).to.equal(4200 ** 2 + 4800 ** 2);

      const cases = await readAggregate(id, 0, 1);
      expect(cases.n).to.equal(1);
      expect(cases.sum).to.equal(3500);
      expect(cases.sumSq).to.equal(3500 ** 2);
    });

    it("her metrik KENDI toplamini tutar — metrikler karismaz", async () => {
      await join(participants[0], 0, [4200, 12000]);
      await join(participants[1], 0, [4800, 13000]);

      const id = await disclose();

      const vo2 = await readAggregate(id, 0, 0);
      const lactate = await readAggregate(id, 1, 0);

      expect(vo2.sum).to.equal(9000);
      expect(lactate.sum).to.equal(25000);
      expect(vo2.sum).to.not.equal(lactate.sum);
    });

    it("gruplar birbirine karismaz", async () => {
      await join(participants[0], 0, [4200, 12000]);
      await join(participants[1], 1, [3500, 11000]);

      const id = await disclose();

      expect((await readAggregate(id, 0, 0)).sum).to.equal(4200);
      expect((await readAggregate(id, 0, 1)).sum).to.equal(3500);
    });
  });

  // -------------------------------------------------------------------------
  describe("Eksik olcum", () => {
    it("olculmemis metrik (0) ne toplama ne de SAYIMA girer", async () => {
      // Ikinci katilimci laktat esigini olcturmemis.
      await join(participants[0], 0, [4200, 12000]);
      await join(participants[1], 0, [4800, 0]);

      const id = await disclose();

      const vo2 = await readAggregate(id, 0, 0);
      expect(vo2.n).to.equal(2);

      const lactate = await readAggregate(id, 1, 0);
      // ISTENEN DAVRANIS: eksik olcum ortalamayi ASAGI CEKMEZ. 0 toplama
      // eklenip n 2 sayilsaydi ortalama 12000 yerine 6000 gorunurdu.
      expect(lactate.n).to.equal(1);
      expect(lactate.sum).to.equal(12000);
      expect(lactate.sumSq).to.equal(12000 ** 2);
    });

    it("hicbir olcumu olmayan katilimci hicbir sayima girmez", async () => {
      await join(participants[0], 0, [4200, 12000]);
      await join(participants[1], 0, [0, 0]);

      const id = await disclose();

      expect((await readAggregate(id, 0, 0)).n).to.equal(1);
      expect((await readAggregate(id, 1, 0)).n).to.equal(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("Arali disi deger", () => {
    it("cok BUYUK deger sinira kirpilmaz, ELENIR", async () => {
      // 4.294.967.295 ml/kg/dk diye bir sey yok. Kirpilsaydi 9000 olur ve
      // "olaganustu sporcu" olarak ortalamayi yukari cekerdi — uydurma ama
      // gecerli gorunen bir gozlem. MK-0013'te genomik tarafta duzeltilen
      // hatanin aynisi.
      await join(participants[0], 0, [4200, 12000]);
      await join(participants[1], 0, [4294967295, 12000]);

      const id = await disclose();

      const vo2 = await readAggregate(id, 0, 0);
      expect(vo2.n).to.equal(1);
      expect(vo2.sum).to.equal(4200);
    });

    it("cok KUCUK deger de elenir", async () => {
      // 1,0 ml/kg/dk (olcekli 100) fizyolojik olarak imkansiz.
      await join(participants[0], 0, [4200, 12000]);
      await join(participants[1], 0, [100, 12000]);

      const id = await disclose();
      expect((await readAggregate(id, 0, 0)).n).to.equal(1);
    });

    it("sinir degerleri DAHILDIR", async () => {
      await join(participants[0], 0, [1500, 1000]); // tam alt sinir
      await join(participants[1], 0, [9000, 20000]); // tam ust sinir

      const id = await disclose();

      const vo2 = await readAggregate(id, 0, 0);
      expect(vo2.n).to.equal(2);
      expect(vo2.sum).to.equal(10500);
    });
  });

  // -------------------------------------------------------------------------
  describe("Partili gonderim", () => {
    it("metrikler ayri partilerde gonderilebilir", async () => {
      await enroll(participants[0], 0);
      await contribute(participants[0], [4200]);
      expect(await biomarkers.submittedMetrics(await participants[0].getAddress())).to.equal(1);

      await contribute(participants[0], [12000]);
      expect(await biomarkers.hasBiomarkerPanel(await participants[0].getAddress())).to.equal(true);

      const id = await disclose();
      expect((await readAggregate(id, 0, 0)).sum).to.equal(4200);
      expect((await readAggregate(id, 1, 0)).sum).to.equal(12000);
    });

    it("panelden fazla metrik gonderilemez", async () => {
      await enroll(participants[0], 0);
      await expect(contribute(participants[0], [4200, 12000, 5000])).to.be.revertedWithCustomError(
        biomarkers,
        "TooManyMetrics",
      );
    });

    it("kaydolmamis adres olcum gonderemez", async () => {
      await expect(contribute(participants[0], [4200])).to.be.revertedWithCustomError(
        biomarkers,
        "NotEnrolled",
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("Panel tanimi", () => {
    it("minValue 0 olan metrik REDDEDILIR", async () => {
      // 0 eksik isaretidir; gecerli araligin disinda kalmak ZORUNDADIR.
      const Biomarkers = await biomarkersFactory();
      const fresh = await Biomarkers.deploy(protocolAddr);

      await expect(
        fresh.connect(owner).configureMetrics(
          [{ ...METRICS[0], minValue: 0 }],
          ethers.ZeroHash,
          "",
        ),
      ).to.be.revertedWithCustomError(fresh, "InvalidMetricRange");
    });

    it("min > max olan metrik REDDEDILIR", async () => {
      // Boyle bir metrik HER olcumu sessizce eksik sayardi.
      const Biomarkers = await biomarkersFactory();
      const fresh = await Biomarkers.deploy(protocolAddr);

      await expect(
        fresh.connect(owner).configureMetrics(
          [{ ...METRICS[0], minValue: 9000, maxValue: 1500 }],
          ethers.ZeroHash,
          "",
        ),
      ).to.be.revertedWithCustomError(fresh, "InvalidMetricRange");
    });

    it("MAX_METRIC_VALUE ustundeki ust sinir REDDEDILIR", async () => {
      // Tasma korumasi: Sum x^2 uint64'e sigmali.
      const Biomarkers = await biomarkersFactory();
      const fresh = await Biomarkers.deploy(protocolAddr);

      await expect(
        fresh.connect(owner).configureMetrics(
          [{ ...METRICS[0], maxValue: 1_048_576 }],
          ethers.ZeroHash,
          "",
        ),
      ).to.be.revertedWithCustomError(fresh, "InvalidMetricRange");
    });

    it("olcek 0 REDDEDILIR", async () => {
      const Biomarkers = await biomarkersFactory();
      const fresh = await Biomarkers.deploy(protocolAddr);

      await expect(
        fresh.connect(owner).configureMetrics(
          [{ ...METRICS[0], scale: 0 }],
          ethers.ZeroHash,
          "",
        ),
      ).to.be.revertedWithCustomError(fresh, "InvalidMetricScale");
    });

    it("ilk katkidan SONRA panel degistirilemez", async () => {
      await join(participants[0], 0, [4200, 12000]);

      await expect(
        biomarkers.connect(owner).configureMetrics(METRICS, ethers.ZeroHash, ""),
      ).to.be.revertedWithCustomError(biomarkers, "MetricsFrozen");
    });

    it("olcek ve birim zincirden okunabilir — istemci donusumunu dogrular", async () => {
      const spec = await biomarkers.metricAt(0);
      expect(spec.scale).to.equal(100);
      expect(ethers.decodeBytes32String(spec.unit)).to.equal("ml/kg/min");
      expect(await biomarkers.metricsHash()).to.equal(ethers.id("metrik-belgesi-v1"));
    });
  });

  // -------------------------------------------------------------------------
  describe("Yetki ayrimi", () => {
    it("modul TEK BASINA cozum yetkisi veremez", async () => {
      // Onay dongusu protokolde durur. Modul kendi basina yetki verebilseydi
      // esik, itiraz suresi ve iptal mekanizmalarinin tamami atlatilirdi.
      await join(participants[0], 0, [4200, 12000]);

      await expect(
        biomarkers.connect(researcher).grantFor(0, await researcher.getAddress()),
      ).to.be.revertedWithCustomError(biomarkers, "NotProtocol");

      await expect(
        biomarkers.connect(owner).snapshotFor(0, 0, 1),
      ).to.be.revertedWithCustomError(biomarkers, "NotProtocol");
    });

    it("acilim YURUTULMEDEN toplamlar cozulemez", async () => {
      await join(participants[0], 0, [4200, 12000]);

      const id = await protocol.nextRequestId();
      await protocol
        .connect(owner)
        .requestDisclosure(await researcher.getAddress(), STATISTICS);

      // Goruntu alindi ama izin verilmedi: cozum basarisiz olmali.
      const [sum] = await biomarkers.disclosureBiomarkerAt(id, 0, 0);
      await expect(
        fhevm.userDecryptEuint(FhevmType.euint64, sum, moduleAddr, researcher),
      ).to.be.rejected;
    });

    it("modul ILK KAYITTAN SONRA baglanamaz", async () => {
      // Sifreli grup etiketinin izni kayit aninda verilir; sonradan baglanan
      // bir modul once kaydolmus katilimcilarin etiketini kullanamazdi.
      const Protocol = await protocolFactory();
      const ProvVerifier = await ethers.getContractFactory("DataProvenanceVerifier");
      const provVerifier = await ProvVerifier.deploy();

      const fresh = await Protocol.deploy(
        await owner.getAddress(), 1, 1,
        await provVerifier.getAddress(), ethers.ZeroHash,
      );
      await fresh.connect(owner).configurePanel(1, 0, ethers.ZeroHash, "");

      const enc = await fhevm
        .createEncryptedInput(await fresh.getAddress(), await participants[0].getAddress())
        .add8(0)
        .encrypt();
      await fresh.connect(participants[0]).enroll(enc.handles[0], enc.inputProof);

      await expect(
        fresh.connect(owner).setBiomarkerModule(moduleAddr),
      ).to.be.revertedWithCustomError(fresh, "PanelFrozen");
    });

    it("baglanan modul DEGISTIRILEMEZ", async () => {
      await expect(
        protocol.connect(owner).setBiomarkerModule(moduleAddr),
      ).to.be.revertedWithCustomError(protocol, "ModuleAlreadyLocked");
    });
  });

  // -------------------------------------------------------------------------
  describe("Anlik goruntu", () => {
    it("talepten SONRA gelen katki goruntuyu degistirmez", async () => {
      await join(participants[0], 0, [4200, 12000]);

      const id = await disclose();
      const before = await readAggregate(id, 0, 0);

      await join(participants[1], 0, [4800, 13000]);

      const after = await readAggregate(id, 0, 0);
      expect(after.sum).to.equal(before.sum);
      expect(after.n).to.equal(before.n);

      // Canli toplam ise buyumeye devam etmis olmali.
      const [liveSum] = await biomarkers.biomarkerAggregate(0, 0);
      const [snapSum] = await biomarkers.disclosureBiomarkerAt(id, 0, 0);
      expect(liveSum).to.not.equal(snapSum);
    });
  });
});
