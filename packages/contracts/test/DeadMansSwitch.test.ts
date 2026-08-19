import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import type { Signer } from "ethers";
import { protocolFactory } from "./helpers/factories";

/**
 * Dead Man's Switch — varis dugumlere yetki devri (rapor §2.6.1).
 *
 * Rapor iki tetikleyici tarif ediyor:
 *   1. ana dugumlerin "belirli bir sure yanit vermemesi" (sessizlik),
 *   2. ana dugumlerin "dusman tarafindan hacklenmesi" (ele gecirme).
 *
 * Ikisi AYNI SEY DEGILDIR ve bu dosya farki acikca test eder: sessizlik
 * tespiti ele gecirmeyi goremez, cunku ele gecirilmis bir dugum susmaz.
 *
 * Testlerin yanitladigi sorular:
 *   - Ana dugumler susunca yetki gercekten varislere geciyor mu?
 *   - Devir halinde ANA dugum hala onaylayabiliyor mu?   (onaylayamamali)
 *   - Varis esigi 9/12 uygulaniyor mu?
 *   - En hassas sorgu kriz aninda KOLAYLASIYOR mu?       (kolaylasmamali)
 *   - Devirden once toplanan onaylar varis esigine sayiliyor mu? (sayilmamali)
 *   - Varis atanmamisken devir olur mu?                  (olmamali)
 */
describe("Dead Man's Switch — varis dugumler (rapor §2.6.1)", () => {
  let owner: Signer;
  let researcher: Signer;
  let alice: Signer;
  // Ana dugumler
  let mainA: Signer;
  let mainB: Signer;
  // Varis dugumler
  let heirA: Signer;
  let heirB: Signer;
  let heirC: Signer;
  let heirD: Signer;

  let protocol: any;

  const LIVENESS_TIMEOUT = 100;
  const STATISTICS = 4;
  const GWAS = 1;

  beforeEach(async () => {
    [owner, researcher, alice, mainA, mainB, heirA, heirB, heirC, heirD] =
      await ethers.getSigners();

    const ProvVerifier = await ethers.getContractFactory("DataProvenanceVerifier");
    const provVerifier = await ProvVerifier.deploy();
    await provVerifier.waitForDeployment();

    const Protocol = await protocolFactory();
    protocol = await Protocol.deploy(
      await owner.getAddress(), 2, 1,
      await provVerifier.getAddress(),
      ethers.ZeroHash,
    );
    await protocol.waitForDeployment();

    for (const n of [mainA, mainB]) {
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

    await protocol.connect(owner).setQueryGateway(await owner.getAddress());
  });

  async function authorizeHeirs(nodes: Signer[]) {
    for (const n of nodes) {
      await protocol.connect(owner).authorizeHeirNode(await n.getAddress());
    }
  }

  async function openRequest(queryType = STATISTICS): Promise<bigint> {
    const id = await protocol.nextRequestId();
    await protocol
      .connect(owner)
      .requestDisclosure(await researcher.getAddress(), queryType);
    return id;
  }

  /** Ana dugumleri susturarak devri tetikler. */
  async function goSilent() {
    await mine(LIVENESS_TIMEOUT + 1);
  }

  // ===================================================================================
  // 1) Devir kosullari
  // ===================================================================================

  describe("Devir ne zaman aktiflesir", () => {
    it("varis atanmamisken devir OLMAZ — havuz kilitlenmemeli", async () => {
      // Yetkiyi kimsenin olmadigi bir kumeye devretmek, havuzu kalici olarak
      // erisilemez yapardi.
      await protocol.connect(owner).setLivenessTimeout(LIVENESS_TIMEOUT);
      await goSilent();

      expect(await protocol.isFailoverActive()).to.equal(false);
    });

    it("esik kapaliyken (0) sessizlik devir tetiklemez", async () => {
      await authorizeHeirs([heirA, heirB, heirC, heirD]);
      await goSilent();

      expect(await protocol.livenessTimeout()).to.equal(0);
      expect(await protocol.isFailoverActive()).to.equal(false);
    });

    it("esik ILK ACILDIGINDA devir aninda tetiklenmez", async () => {
      // Sayac gecmiste 0 kalsaydi, esik acilir acilmaz devir baslardi.
      await authorizeHeirs([heirA, heirB, heirC, heirD]);
      await mine(1_000);

      await protocol.connect(owner).setLivenessTimeout(LIVENESS_TIMEOUT);
      expect(await protocol.isFailoverActive()).to.equal(false);
    });

    it("ana dugumler susunca devir OTOMATIK aktiflesir", async () => {
      await authorizeHeirs([heirA, heirB, heirC, heirD]);
      await protocol.connect(owner).setLivenessTimeout(LIVENESS_TIMEOUT);

      expect(await protocol.isFailoverActive()).to.equal(false);
      await goSilent();
      expect(await protocol.isFailoverActive()).to.equal(true);
    });

    it("yasam isareti devri geri alir", async () => {
      await authorizeHeirs([heirA, heirB, heirC, heirD]);
      await protocol.connect(owner).setLivenessTimeout(LIVENESS_TIMEOUT);
      await goSilent();
      expect(await protocol.isFailoverActive()).to.equal(true);

      await protocol.connect(mainA).heartbeat();
      expect(await protocol.isFailoverActive()).to.equal(false);
    });

    it("ONAY VERMEK de yasam isaretidir — ayrica bildirmek gerekmez", async () => {
      await authorizeHeirs([heirA, heirB, heirC, heirD]);
      await protocol.connect(owner).setLivenessTimeout(LIVENESS_TIMEOUT);

      await mine(LIVENESS_TIMEOUT - 5);
      const requestId = await openRequest();
      await protocol.connect(mainA).approveDisclosure(requestId);

      await mine(10); // eski sayaca gore sure dolmus olurdu
      expect(await protocol.isFailoverActive()).to.equal(false);
    });

    it("varis olmayan biri yasam isareti veremez", async () => {
      await expect(
        protocol.connect(alice).heartbeat(),
      ).to.be.revertedWithCustomError(protocol, "NotAuthorizedNode");
    });
  });

  // ===================================================================================
  // 2) Ele gecirme — sessizlik tespitinin GOREMEDIGI hal
  // ===================================================================================

  describe("Ele gecirme hali (elle ilan)", () => {
    it("ele gecirilmis dugum SUSMAZ — sessizlik tespiti bunu goremez", async () => {
      // Bu test bir eksigi belgeliyor, bir ozelligi degil. Saldirgan yasam
      // isareti gondermeye devam ederek devri sonsuza kadar erteleyebilir.
      await authorizeHeirs([heirA, heirB, heirC, heirD]);
      await protocol.connect(owner).setLivenessTimeout(LIVENESS_TIMEOUT);

      for (let i = 0; i < 5; i++) {
        await mine(LIVENESS_TIMEOUT - 1);
        await protocol.connect(mainA).heartbeat(); // "saldirgan" hayatta gorunuyor
      }

      expect(await protocol.isFailoverActive()).to.equal(false);
    });

    it("elle ilan, sessizlikten BAGIMSIZ olarak devri baslatir", async () => {
      await authorizeHeirs([heirA, heirB, heirC, heirD]);
      await protocol.connect(owner).declareFailover();

      expect(await protocol.isFailoverActive()).to.equal(true);
    });

    it("elle ilan edilen devri YASAM ISARETI temizlemez", async () => {
      // Aksi halde ele gecirilmis dugum, tek bir heartbeat ile kendi
      // yetkisini geri alirdi.
      await authorizeHeirs([heirA, heirB, heirC, heirD]);
      await protocol.connect(owner).declareFailover();

      await protocol.connect(mainA).heartbeat();
      expect(await protocol.isFailoverActive()).to.equal(true);

      await protocol.connect(owner).clearFailover();
      expect(await protocol.isFailoverActive()).to.equal(false);
    });

    it("varis yokken elle ilan reddedilir", async () => {
      await expect(
        protocol.connect(owner).declareFailover(),
      ).to.be.revertedWithCustomError(protocol, "NoHeirNodes");
    });

    it("devri yalnizca sahip ilan edebilir", async () => {
      await authorizeHeirs([heirA, heirB, heirC, heirD]);
      await expect(protocol.connect(mainA).declareFailover()).to.be.reverted;
    });
  });

  // ===================================================================================
  // 3) Yetki gercekten el degistiriyor mu
  // ===================================================================================

  describe("Devir halinde onay yetkisi", () => {
    beforeEach(async () => {
      await authorizeHeirs([heirA, heirB, heirC, heirD]);
      await protocol.connect(owner).setLivenessTimeout(LIVENESS_TIMEOUT);
    });

    it("normal halde VARIS dugum onaylayamaz", async () => {
      const requestId = await openRequest();
      await expect(
        protocol.connect(heirA).approveDisclosure(requestId),
      ).to.be.revertedWithCustomError(protocol, "NotAuthorizedNode");
    });

    it("devir halinde ANA dugum onaylayamaz — devrin ozu budur", async () => {
      const requestId = await openRequest();
      await goSilent();

      await expect(
        protocol.connect(mainA).approveDisclosure(requestId),
      ).to.be.revertedWithCustomError(protocol, "NotHeirNode");
    });

    it("devir halinde VARIS dugumler esigi doldurabilir", async () => {
      const requestId = await openRequest();
      await goSilent();

      // 4 varis, istatistik sorgusu: max(ceil(4*9/12), ceil(4*4/10)) = 3.
      expect(await protocol.heirRequiredApprovals(STATISTICS)).to.equal(3);

      await protocol.connect(heirA).approveDisclosure(requestId);
      await protocol.connect(heirB).approveDisclosure(requestId);
      expect(await protocol.isDisclosureFinalized(requestId)).to.equal(false);

      await protocol.connect(heirC).approveDisclosure(requestId);
      expect(await protocol.isDisclosureFinalized(requestId)).to.equal(true);
    });

    it("devirden ONCE toplanan ana onaylar varis esigine SAYILMAZ", async () => {
      // Devir "ana dugumlere guvenilmiyor" demektir. Karistirmak, ele
      // gecirilmis dugumlerin biriktirdigi onaylarin varis esigini
      // doldurmasina izin verirdi.
      const requestId = await openRequest();

      await protocol.connect(mainA).approveDisclosure(requestId); // 1/1? hayir: 2 dugum, 4/10 -> 1
      // 2 ana dugum, istatistik: ceil(2*4/10) = 1 -> tek onayla esik dolar.
      // Bu yuzden esigi dolduramayacak bir sorgu tipi secilir: GWAS 9/10 -> 2.
      const gwasId = await openRequest(GWAS);
      await protocol.connect(mainA).approveDisclosure(gwasId);
      expect(await protocol.isDisclosureFinalized(gwasId)).to.equal(false);

      await goSilent();

      // Varis esigi: max(ceil(4*9/12), ceil(4*9/10)) = max(3, 4) = 4.
      expect(await protocol.heirRequiredApprovals(GWAS)).to.equal(4);

      await protocol.connect(heirA).approveDisclosure(gwasId);
      await protocol.connect(heirB).approveDisclosure(gwasId);
      await protocol.connect(heirC).approveDisclosure(gwasId);
      // Ana dugumun onayi sayilsaydi burada esik dolmus olurdu.
      expect(await protocol.isDisclosureFinalized(gwasId)).to.equal(false);

      await protocol.connect(heirD).approveDisclosure(gwasId);
      expect(await protocol.isDisclosureFinalized(gwasId)).to.equal(true);
    });

    it("ayni varis iki kez onaylayamaz", async () => {
      const requestId = await openRequest();
      await goSilent();

      await protocol.connect(heirA).approveDisclosure(requestId);
      await expect(
        protocol.connect(heirA).approveDisclosure(requestId),
      ).to.be.revertedWithCustomError(protocol, "AlreadyApproved");
    });

    it("devirden SONRA acilan talep de varislerce sonuclandirilir", async () => {
      await goSilent();
      const requestId = await openRequest();

      await protocol.connect(heirA).approveDisclosure(requestId);
      await protocol.connect(heirB).approveDisclosure(requestId);
      await protocol.connect(heirC).approveDisclosure(requestId);

      expect(await protocol.isDisclosureFinalized(requestId)).to.equal(true);
      await expect(protocol.executeDisclosure(requestId)).to.not.be.reverted;
    });
  });

  // ===================================================================================
  // 4) Varis esigi — 9/12 ve kademeli esiklerin buyugu
  // ===================================================================================

  describe("Varis esigi (rapor §2.6.1: 9/12)", () => {
    it("raporun 12 varisli ornegi tam 9 onay ister", async () => {
      const [, , , , , , , , , ...rest] = await ethers.getSigners();
      const twelve = [heirA, heirB, heirC, heirD, ...rest.slice(0, 8)];
      expect(twelve.length).to.equal(12);
      await authorizeHeirs(twelve);

      expect(await protocol.heirNodeCount()).to.equal(12);
      expect(await protocol.heirRequiredApprovals(STATISTICS)).to.equal(9);
    });

    it("EN HASSAS sorgu kriz aninda KOLAYLASMAZ", async () => {
      // Yalnizca 9/12 (%75) uygulansaydi, populasyon genetigi sorgusu
      // (9/10 = %90) kriz aninda DAHA KOLAY gecerdi — amacin tam tersi.
      const [, , , , , , , , , ...rest] = await ethers.getSigners();
      await authorizeHeirs([heirA, heirB, heirC, heirD, ...rest.slice(0, 8)]);

      const crisis = await protocol.heirRequiredApprovals(GWAS);
      // max(ceil(12*9/12), ceil(12*9/10)) = max(9, 11) = 11
      expect(crisis).to.equal(11);
      expect(crisis).to.be.greaterThan(9);
    });

    it("varis yokken esik sorulamaz", async () => {
      await expect(
        protocol.heirRequiredApprovals(STATISTICS),
      ).to.be.revertedWithCustomError(protocol, "NoHeirNodes");
    });

    it("varis yetkisi geri alinabilir", async () => {
      await authorizeHeirs([heirA, heirB]);
      expect(await protocol.heirNodeCount()).to.equal(2);

      await protocol.connect(owner).revokeHeirNode(await heirA.getAddress());
      expect(await protocol.heirNodeCount()).to.equal(1);
      expect(await protocol.isHeirNode(await heirA.getAddress())).to.equal(false);
    });
  });

  // ===================================================================================
  // 5) Kilitlenme olmamali
  // ===================================================================================

  describe("Kilitlenme yok", () => {
    it("talep acildiktan SONRA ana dugumler susarsa talep yine sonuclanir", async () => {
      // Devir esigi talep aninda AYRICA dondurulmezse bu talep sonsuza kadar
      // onaylanamaz ve havuz kalici olarak erisilemez hale gelirdi.
      await authorizeHeirs([heirA, heirB, heirC, heirD]);
      await protocol.connect(owner).setLivenessTimeout(LIVENESS_TIMEOUT);

      const requestId = await openRequest();
      await goSilent();

      await protocol.connect(heirA).approveDisclosure(requestId);
      await protocol.connect(heirB).approveDisclosure(requestId);
      await protocol.connect(heirC).approveDisclosure(requestId);

      expect(await protocol.isDisclosureFinalized(requestId)).to.equal(true);
    });

    it("varis SONRADAN atanmissa eski talep varislerce kapatilamaz", async () => {
      // Bu bilincli bir sinirdir: talep acildiginda varis esigi hesaplanamaz,
      // cunku varis yoktu. Cozum yeni talep acmaktir — sessizce yanlis bir
      // esik uydurmaktan iyidir.
      await protocol.connect(owner).setLivenessTimeout(LIVENESS_TIMEOUT);
      const requestId = await openRequest();

      await authorizeHeirs([heirA, heirB, heirC, heirD]);
      await goSilent();

      await expect(
        protocol.connect(heirA).approveDisclosure(requestId),
      ).to.be.revertedWithCustomError(protocol, "NoHeirNodes");

      // Yeni talep sorunsuz acilir ve kapanir.
      const fresh = await openRequest();
      await protocol.connect(heirA).approveDisclosure(fresh);
      await protocol.connect(heirB).approveDisclosure(fresh);
      await protocol.connect(heirC).approveDisclosure(fresh);
      expect(await protocol.isDisclosureFinalized(fresh)).to.equal(true);
    });
  });
});
