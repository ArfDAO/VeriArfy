import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/mock-utils";
import type { Signer } from "ethers";

import { fullCoverage, protocolFactory } from "./helpers/factories";

/**
 * Kapsama bitmap'i — kimin HANGI ALANDA gercek verisi var.
 *
 * # Neden var
 *
 * Odeme, KULLANILAN ALANA gore dagitilir: arastirmaci {rs4977574, VO2MAX}
 * isterse, o alanlara gercekten veri vermis olanlar pay alir. Bunu
 * hesaplayabilmek icin kapsama duz metin olmak zorundadir.
 *
 * # Bu dosyanin yanitladigi sorular
 *
 *   - Bitmap dogru yaziliyor mu, sayaclar dogru artiyor mu?
 *   - Ayni alan iki kez sayilabiliyor mu?              (sayilmamali)
 *   - Odeme agirligi (pay / payda) dogru mu?
 *   - KAPSAMA YALANI ISTATISTIGI BOZUYOR MU?           (BOZMAMALI)
 *
 * Sonuncusu en onemlisi: sozlesme bitmap'in sifreli veriyle ortustugunu
 * DOGRULAYAMAZ. Yalanin nerede durdugu bilinmeli — istatistik sifreli
 * degere bakar, bitmap yalnizca odemeyi etkiler.
 */
describe("Kapsama bitmap'i (odeme icin alan secimi)", () => {
  let owner: Signer;
  let researcher: Signer;
  let nodeA: Signer;
  let participants: Signer[];

  let protocol: any;
  let protocolAddr: string;

  const SNP_COUNT = 6;
  const STATISTICS = 4;

  beforeEach(async () => {
    const signers = await ethers.getSigners();
    [owner, researcher, nodeA] = signers;
    participants = signers.slice(3, 11);

    const ProvVerifier = await ethers.getContractFactory("DataProvenanceVerifier");
    const provVerifier = await ProvVerifier.deploy();
    await provVerifier.waitForDeployment();

    const Protocol = await protocolFactory();
    protocol = await Protocol.deploy(
      await owner.getAddress(), 2, 1, await provVerifier.getAddress(), ethers.ZeroHash,
    );
    await protocol.waitForDeployment();
    protocolAddr = await protocol.getAddress();

    await protocol.connect(owner).configurePanel(SNP_COUNT, 0, ethers.ZeroHash, "");
    await protocol.connect(owner).authorizeNode(await nodeA.getAddress());
    await protocol.connect(owner).setQueryGateway(await owner.getAddress());
  });

  /** Kayit + dozajlar. `mask` verilmezse dozajlardan TURETILIR. */
  async function join(signer: Signer, group: number, dosages: number[], mask?: bigint) {
    const enc = await fhevm.createEncryptedInput(protocolAddr, await signer.getAddress());
    enc.add8(group);
    for (const d of dosages) enc.add8(d);
    const input = await enc.encrypt();

    await protocol.connect(signer).enroll(input.handles[0], input.inputProof);

    // Istemcinin yaptigi sey: maskeyi hizalanmis dozajlardan turetmek.
    // 3 = DOSAGE_MISSING.
    const derived =
      mask ??
      dosages.reduce((m, d, i) => (d === 3 ? m : m | (1n << BigInt(i))), 0n);

    await protocol
      .connect(signer)
      .contributeDosages(input.handles.slice(1), derived, input.inputProof);
  }

  const ids = (...xs: number[]) => xs;

  // -------------------------------------------------------------------------
  describe("Bitmap ve sayaclar", () => {
    it("kapsanan alanlar isaretlenir, eksikler isaretlenmez", async () => {
      // 2. ve 5. alanlar eksik (dosyada yok).
      await join(participants[0], 0, [1, 0, 3, 2, 1, 3]);

      const who = await participants[0].getAddress();
      expect(await protocol.hasSnpCoverage(who, 0)).to.equal(true);
      expect(await protocol.hasSnpCoverage(who, 2)).to.equal(false);
      expect(await protocol.hasSnpCoverage(who, 3)).to.equal(true);
      expect(await protocol.hasSnpCoverage(who, 5)).to.equal(false);
    });

    it("alan sayaclari yalnizca gercek veri verenleri sayar", async () => {
      await join(participants[0], 0, [1, 3, 1, 3, 1, 3]);
      await join(participants[1], 1, [0, 0, 3, 3, 1, 3]);

      expect(await protocol.snpCoverageCount(0)).to.equal(2); // ikisi de
      expect(await protocol.snpCoverageCount(1)).to.equal(1); // yalnizca ikinci
      expect(await protocol.snpCoverageCount(3)).to.equal(0); // hicbiri
      expect(await protocol.snpCoverageCount(5)).to.equal(0);
    });

    it("ayni alan IKI KEZ sayilmaz", async () => {
      // Partili gonderimde ayni alan tekrar isaretlenirse payda sisirilir
      // ve herkesin payi seyrelir.
      const signer = participants[0];
      const enc = await fhevm.createEncryptedInput(protocolAddr, await signer.getAddress());
      enc.add8(0);
      for (let i = 0; i < SNP_COUNT; i++) enc.add8(1);
      const input = await enc.encrypt();

      await protocol.connect(signer).enroll(input.handles[0], input.inputProof);

      // Ilk parti: 0..2
      await protocol
        .connect(signer)
        .contributeDosages(input.handles.slice(1, 4), fullCoverage(3), input.inputProof);
      // Ikinci parti: 3..5
      await protocol
        .connect(signer)
        .contributeDosages(input.handles.slice(4, 7), fullCoverage(3), input.inputProof);

      for (let i = 0; i < SNP_COUNT; i++) {
        expect(await protocol.snpCoverageCount(i)).to.equal(1);
      }
    });

    it("olay bu partide ILK KEZ kapsanan alan sayisini bildirir", async () => {
      // Sayac zincirde bir depolama yuvasi tutmuyor; toplam olaylardan
      // turetiliyor. Bu yuzden olayin dogru sayiyi tasidigi dogrulanmali.
      const signer = participants[0];
      const dosages = [1, 3, 1, 3, 1, 3]; // uc alan gercek, uc alan eksik

      const enc = await fhevm.createEncryptedInput(protocolAddr, await signer.getAddress());
      enc.add8(0);
      for (const d of dosages) enc.add8(d);
      const input = await enc.encrypt();

      await protocol.connect(signer).enroll(input.handles[0], input.inputProof);

      const mask = dosages.reduce((m, d, i) => (d === 3 ? m : m | (1n << BigInt(i))), 0n);
      const tx = await protocol
        .connect(signer)
        .contributeDosages(input.handles.slice(1), mask, input.inputProof);

      await expect(tx)
        .to.emit(protocol, "DosagesContributed")
        .withArgs(await signer.getAddress(), 0, SNP_COUNT, 3);
    });
  });

  // -------------------------------------------------------------------------
  describe("Odeme agirligi", () => {
    it("pay = katilimcinin ISTENEN alanlardan kacinda verisi var", async () => {
      //            alan:  0  1  2  3  4  5
      await join(participants[0], 0, [1, 1, 1, 3, 3, 3]); // 0,1,2
      await join(participants[1], 1, [1, 3, 1, 1, 3, 3]); // 0,2,3

      const a = await participants[0].getAddress();
      const b = await participants[1].getAddress();

      // Arastirmaci {0, 3} istiyor.
      expect(await protocol.snpCoverageWeight(a, ids(0, 3))).to.equal(1);
      expect(await protocol.snpCoverageWeight(b, ids(0, 3))).to.equal(2);
    });

    it("payda = istenen alanlarin kapsama sayaclari toplami", async () => {
      await join(participants[0], 0, [1, 1, 1, 3, 3, 3]);
      await join(participants[1], 1, [1, 3, 1, 1, 3, 3]);

      // alan 0 -> 2 kisi, alan 3 -> 1 kisi
      expect(await protocol.snpCoverageTotal(ids(0, 3))).to.equal(3);

      // Paylarin toplami paydaya esit olmali; aksi halde havuz ya asilir ya
      // eksik dagitilir.
      const a = await protocol.snpCoverageWeight(await participants[0].getAddress(), ids(0, 3));
      const b = await protocol.snpCoverageWeight(await participants[1].getAddress(), ids(0, 3));
      expect(Number(a) + Number(b)).to.equal(3);
    });

    it("hic verisi olmayan alan istenirse agirlik SIFIR", async () => {
      await join(participants[0], 0, [1, 1, 1, 3, 3, 3]);

      expect(
        await protocol.snpCoverageWeight(await participants[0].getAddress(), ids(4, 5)),
      ).to.equal(0);
      expect(await protocol.snpCoverageTotal(ids(4, 5))).to.equal(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("Guven siniri — yalanin nerede durdugu", () => {
    it("KAPSAMA YALANI ISTATISTIGI BOZMAZ", async () => {
      // Kotu niyetli istemci: 2. alanda eksik veri gonderiyor ama "bende var"
      // diyor. Sozlesme bunu dogrulayamaz — sifreli olmasinin anlami budur.
      //
      // Kritik olan yalanin NEREDE DURDUGU: kontenjans tablosuna sifreli
      // deger karar verir, bitmap DEGIL.
      await join(participants[0], 0, [1, 1, 3, 1, 1, 1], fullCoverage(6)); // yalan
      await join(participants[1], 0, [1, 1, 1, 1, 1, 1]); // durust
      await join(participants[2], 1, [1, 1, 1, 1, 1, 1]);

      const who = await participants[0].getAddress();

      // Bitmap yalani kabul etti — odeme etkilenir.
      expect(await protocol.hasSnpCoverage(who, 2)).to.equal(true);

      // Ama ISTATISTIK bozulmadi: 2. alanda yalnizca IKI gercek gozlem var.
      const id = await protocol.nextRequestId();
      await protocol
        .connect(owner)
        .requestDisclosureFields(
          await researcher.getAddress(),
          STATISTICS,
          Array.from({ length: SNP_COUNT }, (_, i) => i),
          [],
        );
      await protocol.connect(nodeA).approveDisclosure(id);
      await protocol.executeDisclosure(id);

      const table = await protocol.disclosureContingencyAt(id, 2);
      let total = 0;
      for (let g = 0; g < 2; g++) {
        for (let level = 0; level < 3; level++) {
          total += Number(
            await fhevm.userDecryptEuint(
              FhevmType.euint32, table[g][level], protocolAddr, researcher,
            ),
          );
        }
      }
      expect(total, "eksik gonderen katilimci tabloya girmemeli").to.equal(2);

      // Karsilastirma: yalan soylenmeyen alanda uc gozlem var.
      const clean = await protocol.disclosureContingencyAt(id, 0);
      let cleanTotal = 0;
      for (let g = 0; g < 2; g++) {
        for (let level = 0; level < 3; level++) {
          cleanTotal += Number(
            await fhevm.userDecryptEuint(
              FhevmType.euint32, clean[g][level], protocolAddr, researcher,
            ),
          );
        }
      }
      expect(cleanTotal).to.equal(3);
    });

    it("kapsamayi EKSIK bildiren kendi payini kaybeder, tabloya yine girer", async () => {
      // Ters yon: veri var ama "yok" deniyor. Istatistik yine dogru,
      // katilimci yalnizca kendi odemesinden olur.
      await join(participants[0], 0, [1, 1, 1, 1, 1, 1], 0n);

      const who = await participants[0].getAddress();
      expect(await protocol.hasSnpCoverage(who, 0)).to.equal(false);
      expect(await protocol.snpCoverageWeight(who, ids(0, 1, 2))).to.equal(0);
      // Ama havuza girdi:
      expect(await protocol.submittedSnps(who)).to.equal(SNP_COUNT);
    });
  });
});
