import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/mock-utils";
import type { Signer } from "ethers";
import { fullCoverage, protocolFactory } from "./helpers/factories";

/**
 * Cok SNP'li GWAS — rapor §3.3.
 *
 * Ilk surumde kontenjans tablosu TEK bir varyant icindi. Gercek bir GWAS
 * calismasi onlarca-binlerce varyant tarar; bu dosya panelin gercekten
 * olceklendigini ve istatistigin SNP basina dogru kaldigini dogrular.
 *
 * Testlerin yanitladigi sorular:
 *
 *   - Her SNP kendi tablosunu mu tutuyor, yoksa hepsi karisiyor mu?
 *   - Partiler halinde gonderim sayimi bozuyor mu?
 *   - Yarim kalan katilimci k-anonimlik sayisina giriyor mu?  (girmemeli)
 *   - Katilimci partiler arasinda grup degistirebiliyor mu?    (degistirememeli)
 *   - Acilim penceresi sinirli mi?
 *   - Panel katki basladiktan sonra degistirilebiliyor mu?     (degistirilememeli)
 *
 * Sifreleme her adimda gercek FHE'dir; tablo hicbir noktada duz metne
 * dokunmadan doldurulur.
 */
describe("Cok SNP'li GWAS (rapor §3.3)", () => {
  let owner: Signer;
  let researcher: Signer;
  let nodeA: Signer;
  let nodeB: Signer;
  let participants: Signer[];

  let protocol: any;
  let protocolAddr: string;

  /** Kucuk ama gercekci bir panel; gaz olcumu de bunun uzerinden yapilir. */
  const SNP_COUNT = 6;
  const RARE_SNP = 2;
  const STATISTICS = 4;

  beforeEach(async () => {
    const signers = await ethers.getSigners();
    [owner, researcher, nodeA, nodeB] = signers;
    participants = signers.slice(4, 12);

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
    protocolAddr = await protocol.getAddress();

    await protocol
      .connect(owner)
      .configurePanel(SNP_COUNT, RARE_SNP, ethers.ZeroHash, "");

    for (const node of [nodeA, nodeB]) {
      await protocol.connect(owner).authorizeNode(await node.getAddress());
    }
    await protocol.connect(owner).setQueryGateway(await owner.getAddress());
  });

  /** Katilimciyi gruba kaydeder (sifreli). */
  async function enroll(signer: Signer, group: number) {
    const enc = await fhevm
      .createEncryptedInput(protocolAddr, await signer.getAddress())
      .add8(group)
      .encrypt();
    await protocol.connect(signer).enroll(enc.handles[0], enc.inputProof);
  }

  /** Bir dilim dozaj gonderir. */
  async function contribute(signer: Signer, dosages: number[]) {
    const builder = fhevm.createEncryptedInput(protocolAddr, await signer.getAddress());
    for (const d of dosages) builder.add8(d);
    const enc = await builder.encrypt();

    await protocol
      .connect(signer)
      .contributeDosages(enc.handles, fullCoverage(dosages.length), enc.inputProof);
  }

  /** Kayit + tum panel tek partide. */
  async function joinFull(signer: Signer, group: number, dosages: number[]) {
    await enroll(signer, group);
    await contribute(signer, dosages);
  }

  /**
   * Acilim talebini acar, onaylatir ve yurutur.
   *
   * @remarks Arastirmaci artik ARALIK degil LISTE secer; bu yardimci geriye
   *          donuk kolaylik icin araligi listeye cevirir.
   */
  async function disclose(from = 0, window = SNP_COUNT): Promise<bigint> {
    const snpIds = Array.from({ length: window }, (_, i) => from + i);
    return discloseFields(snpIds);
  }

  /** Acilim talebini SECILEN alanlar icin acar. */
  async function discloseFields(snpIds: number[]): Promise<bigint> {
    const id = await protocol.nextRequestId();
    await protocol
      .connect(owner)
      .requestDisclosureFields(await researcher.getAddress(), STATISTICS, snpIds, []);
    // 2 dugum + istatistik esigi (4/10) -> ceil(2 x 0,4) = 1 onay yeter.
    // Ikinci onay `AlreadyFinalized` ile duser; esik saglanana kadar onaylanir.
    await protocol.connect(nodeA).approveDisclosure(id);
    if (!(await protocol.isDisclosureFinalized(id))) {
      await protocol.connect(nodeB).approveDisclosure(id);
    }
    await protocol.executeDisclosure(id);
    return id;
  }

  /** Bir SNP'nin tablosunu duz metne cozer (arastirmaci yetkisiyle). */
  async function readTable(requestId: bigint, snp: number): Promise<number[][]> {
    const handles = await protocol.disclosureContingencyAt(requestId, snp);
    const table: number[][] = [];
    for (let g = 0; g < 2; g++) {
      const row: number[] = [];
      for (let level = 0; level < 3; level++) {
        row.push(
          Number(
            await fhevm.userDecryptEuint(
              FhevmType.euint32, handles[g][level], protocolAddr, researcher,
            ),
          ),
        );
      }
      table.push(row);
    }
    return table;
  }

  // ===================================================================================
  // 1) Her SNP kendi tablosunu tutuyor mu
  // ===================================================================================

  describe("SNP basina ayri tablo", () => {
    it("farkli SNP'ler KARISMIYOR", async () => {
      // Iki katilimci, panel boyunca FARKLI desenler. Tablolar karissaydi
      // her SNP ayni sayilari gosterirdi.
      await joinFull(participants[0], 0, [0, 1, 2, 0, 1, 2]);
      await joinFull(participants[1], 1, [2, 2, 2, 2, 2, 2]);

      const id = await disclose();

      // SNP 0: kontrol dozaj 0'da 1 kisi, vaka dozaj 2'de 1 kisi.
      expect(await readTable(id, 0)).to.deep.equal([[1, 0, 0], [0, 0, 1]]);
      // SNP 1: kontrol dozaj 1'de, vaka dozaj 2'de.
      expect(await readTable(id, 1)).to.deep.equal([[0, 1, 0], [0, 0, 1]]);
      // SNP 2: ikisi de dozaj 2 ama farkli gruplarda.
      expect(await readTable(id, 2)).to.deep.equal([[0, 0, 1], [0, 0, 1]]);
    });

    it("her SNP'nin toplami katilimci sayisina esit — hicbir katki kaybolmuyor", async () => {
      const cohort: Array<[number, number[]]> = [
        [0, [0, 1, 2, 1, 0, 2]],
        [0, [1, 1, 0, 2, 2, 1]],
        [1, [2, 0, 1, 0, 1, 0]],
        [1, [2, 2, 2, 1, 1, 2]],
      ];
      for (const [i, [group, dosages]] of cohort.entries()) {
        await joinFull(participants[i], group, dosages);
      }

      const id = await disclose();

      for (let snp = 0; snp < SNP_COUNT; snp++) {
        const table = await readTable(id, snp);
        const total = table.flat().reduce((a, b) => a + b, 0);
        expect(total, `SNP ${snp} toplami`).to.equal(cohort.length);
      }
    });

    it("tablolar duz metin hesabiyla BIREBIR ayni", async () => {
      const cohort: Array<[number, number[]]> = [
        [0, [0, 2, 1, 1, 0, 2]],
        [0, [0, 1, 1, 2, 2, 0]],
        [1, [2, 2, 0, 1, 1, 1]],
        [1, [1, 2, 2, 0, 2, 1]],
        [1, [2, 0, 1, 1, 0, 2]],
      ];
      for (const [i, [group, dosages]] of cohort.entries()) {
        await joinFull(participants[i], group, dosages);
      }

      // Bagimsiz duz metin hesabi — sifreli tabloyla karsilastirilacak.
      const expected: number[][][] = Array.from({ length: SNP_COUNT }, () => [
        [0, 0, 0],
        [0, 0, 0],
      ]);
      for (const [group, dosages] of cohort) {
        dosages.forEach((d, snp) => {
          expected[snp][group][d] += 1;
        });
      }

      const id = await disclose();
      for (let snp = 0; snp < SNP_COUNT; snp++) {
        expect(await readTable(id, snp), `SNP ${snp}`).to.deep.equal(expected[snp]);
      }
    });
  });

  // ===================================================================================
  // 2) Partili gonderim
  // ===================================================================================

  describe("Partili gonderim", () => {
    it("parti parti gonderim tek seferlikle AYNI sonucu verir", async () => {
      const dosages = [1, 2, 0, 2, 1, 0];

      await enroll(participants[0], 1);
      await contribute(participants[0], dosages.slice(0, 2));
      await contribute(participants[0], dosages.slice(2, 5));
      await contribute(participants[0], dosages.slice(5));

      await joinFull(participants[1], 1, dosages); // ayni desen, tek partide

      const id = await disclose();
      for (let snp = 0; snp < SNP_COUNT; snp++) {
        const table = await readTable(id, snp);
        // Ikisi de ayni grup ve ayni dozaj -> tek hucrede 2 kisi.
        expect(table[1][dosages[snp]], `SNP ${snp}`).to.equal(2);
      }
    });

    it("ilerleme takip ediliyor", async () => {
      const addr = await participants[0].getAddress();
      await enroll(participants[0], 0);
      expect(await protocol.submittedSnps(addr)).to.equal(0);

      await contribute(participants[0], [1, 1]);
      expect(await protocol.submittedSnps(addr)).to.equal(2);

      await contribute(participants[0], [0, 0, 0, 0]);
      expect(await protocol.submittedSnps(addr)).to.equal(SNP_COUNT);
      expect(await protocol.hasAggregated(addr)).to.equal(true);
    });

    it("panelden FAZLA gonderilemez", async () => {
      await enroll(participants[0], 0);
      await expect(
        contribute(participants[0], [0, 0, 0, 0, 0, 0, 0]),
      ).to.be.revertedWithCustomError(protocol, "TooManySnps");
    });

    it("kaydolmadan dozaj gonderilemez", async () => {
      await expect(
        contribute(participants[0], [1]),
      ).to.be.revertedWithCustomError(protocol, "NotEnrolled");
    });

    it("bos parti reddedilir", async () => {
      await enroll(participants[0], 0);
      await expect(
        protocol.connect(participants[0]).contributeDosages([], 0, "0x"),
      ).to.be.revertedWithCustomError(protocol, "EmptyBatch");
    });

    it("grup partiler arasinda DEGISTIRILEMEZ", async () => {
      // Grup bir kez yazilir; ikinci kayit denemesi reddedilir. Aksi halde
      // katilimci yarida grup degistirip tabloyu bozabilirdi.
      await enroll(participants[0], 0);
      await expect(enroll(participants[0], 1)).to.be.revertedWithCustomError(
        protocol, "AlreadyEnrolled",
      );
    });
  });

  // ===================================================================================
  // 3) Yarim kalan katilimci
  // ===================================================================================

  describe("Yarim kalan katki", () => {
    it("paneli TAMAMLAMAYAN katilimci sayilmaz", async () => {
      await enroll(participants[0], 0);
      await contribute(participants[0], [1, 1, 1]); // 6'da 3

      // k-anonimlik ve gelir paylasimi eksik veriyi tam saymamali.
      expect(await protocol.participantCount()).to.equal(0);
      expect(await protocol.participantIndex(await participants[0].getAddress())).to.equal(0);
      expect(await protocol.hasAggregated(await participants[0].getAddress())).to.equal(false);
    });

    it("tamamlayinca sayilir", async () => {
      await joinFull(participants[0], 0, [1, 1, 1, 1, 1, 1]);
      expect(await protocol.participantCount()).to.equal(1);
      expect(await protocol.participantIndex(await participants[0].getAddress())).to.equal(1);
    });

    it("yarim katki tabloya GIRMISTIR — sayilmamak veriyi geri almaz", async () => {
      // Bu bilincli bir sinir: homomorfik toplamdan bir terim cikarilamaz.
      // Yarim kalan katki tabloda kalir ama katilimci sayilmaz; yani tablo
      // toplami katilimci sayisindan BUYUK olabilir.
      await joinFull(participants[0], 0, [0, 0, 0, 0, 0, 0]);
      await enroll(participants[1], 0);
      await contribute(participants[1], [0, 0]); // yarim

      const id = await disclose();
      const table = await readTable(id, 0);
      const total = table.flat().reduce((a, b) => a + b, 0);

      expect(await protocol.participantCount()).to.equal(1);
      expect(total, "SNP 0 tablosunda yarim katki da var").to.equal(2);
    });
  });

  // ===================================================================================
  // 4) Acilim penceresi
  // ===================================================================================

  describe("Acilim penceresi", () => {
    it("yalnizca ISTENEN aralik cozulebilir", async () => {
      await joinFull(participants[0], 0, [0, 1, 2, 0, 1, 2]);

      const id = await disclose(2, 2); // SNP 2 ve 3
      const ids = await protocol.disclosureSnpIds(id);
      expect(ids.map(Number)).to.deep.equal([2, 4 - 1]);

      expect(await readTable(id, 2)).to.deep.equal([[0, 0, 1], [0, 0, 0]]);
      expect(await readTable(id, 3)).to.deep.equal([[1, 0, 0], [0, 0, 0]]);
    });

    it("pencere disindaki SNP okunamaz", async () => {
      await joinFull(participants[0], 0, [0, 1, 2, 0, 1, 2]);
      const id = await disclose(0, 2);

      await expect(
        protocol.disclosureContingencyAt(id, 4),
      ).to.be.revertedWithCustomError(protocol, "SnpOutsideWindow");
    });

    it("BITISIK OLMAYAN alanlar secilebilir", async () => {
      // Gercek arastirma "SNP 0-9" istemez; belirli varyantlari ister.
      await joinFull(participants[0], 0, [0, 1, 2, 0, 1, 2]);

      const id = await discloseFields([0, 3, 5]);
      expect((await protocol.disclosureSnpIds(id)).map(Number)).to.deep.equal([0, 3, 5]);

      // Secilenler okunabilir...
      expect(await readTable(id, 5)).to.deep.equal([[0, 0, 1], [0, 0, 0]]);
      // ...secilmeyen okunamaz.
      await expect(
        protocol.disclosureContingencyAt(id, 4),
      ).to.be.revertedWithCustomError(protocol, "SnpOutsideWindow");
    });

    it("pencere ust sinirdan buyuk olamaz", async () => {
      await joinFull(participants[0], 0, [0, 0, 0, 0, 0, 0]);
      const max = await protocol.MAX_DISCLOSURE_WINDOW();

      await expect(
        protocol
          .connect(owner)
          .requestDisclosureFields(
            await researcher.getAddress(),
            STATISTICS,
            Array.from({ length: Number(max) + 1 }, (_, i) => i),
            [],
          ),
      ).to.be.reverted;
    });
  });

  // ===================================================================================
  // 5) Panel yapilandirmasi
  // ===================================================================================

  describe("Panel yapilandirmasi", () => {
    it("ilk katkidan SONRA degistirilemez", async () => {
      await enroll(participants[0], 0);
      await expect(
        protocol.connect(owner).configurePanel(10, 0, ethers.ZeroHash, ""),
      ).to.be.revertedWithCustomError(protocol, "PanelFrozen");
    });

    it("sifir SNP kabul edilmez", async () => {
      const Protocol = await protocolFactory();
      const Verifier = await ethers.getContractFactory("DataProvenanceVerifier");
      const v = await Verifier.deploy();
      await v.waitForDeployment();
      const fresh = await Protocol.deploy(
        await owner.getAddress(), 2, 1, await v.getAddress(), ethers.ZeroHash,
      );
      await expect(
        fresh.connect(owner).configurePanel(0, 0, ethers.ZeroHash, ""),
      ).to.be.revertedWithCustomError(fresh, "InvalidSnpCount");
    });

    it("nadirlik SNP'si panelin disinda olamaz", async () => {
      const Protocol = await protocolFactory();
      const Verifier = await ethers.getContractFactory("DataProvenanceVerifier");
      const v = await Verifier.deploy();
      await v.waitForDeployment();
      const fresh = await Protocol.deploy(
        await owner.getAddress(), 2, 1, await v.getAddress(), ethers.ZeroHash,
      );
      await expect(
        fresh.connect(owner).configurePanel(5, 5, ethers.ZeroHash, ""),
      ).to.be.revertedWithCustomError(fresh, "InvalidSnpCount");
    });

    it("cok SNP'li panelde tek-SNP kisayolu reddedilir", async () => {
      const enc = await fhevm
        .createEncryptedInput(protocolAddr, await participants[0].getAddress())
        .add8(0)
        .add8(1)
        .encrypt();

      await expect(
        protocol
          .connect(participants[0])
          .aggregateDosage(enc.handles[0], enc.handles[1], enc.inputProof),
      ).to.be.revertedWithCustomError(protocol, "UseBatchApi");
    });
  });

  // ===================================================================================
  // 6) Eksik veri (DOSAGE_MISSING)
  // ===================================================================================

  describe("Eksik veri", () => {
    it("eksik isaretli SNP o varyantin tablosuna GIRMEZ", async () => {
      // Tuketici cipleri panelin tamamini kapsamaz. Eksik varyanta 0 yazmak
      // "homozigot referans" demektir ve alel frekansini bozar; dogru davranis
      // o katilimciyi O SNP'nin tablosundan tamamen dislamaktir.
      const MISSING = Number(await protocol.DOSAGE_MISSING());
      expect(MISSING).to.equal(3);

      // SNP 1 eksik, digerleri dolu.
      await joinFull(participants[0], 0, [1, MISSING, 2, 0, 1, 2]);
      await joinFull(participants[1], 0, [1, 1, 2, 0, 1, 2]);

      const id = await disclose();

      // SNP 0: iki katilimci da sayilir.
      const snp0 = await readTable(id, 0);
      expect(snp0.flat().reduce((a, b) => a + b, 0)).to.equal(2);

      // SNP 1: yalnizca eksik OLMAYAN katilimci sayilir.
      const snp1 = await readTable(id, 1);
      expect(snp1.flat().reduce((a, b) => a + b, 0)).to.equal(1);
      expect(snp1[0][1]).to.equal(1);
    });

    it("arali disi deger tabloyu BOZMAZ, eksik sayilir", async () => {
      // Kotu niyetli bir istemci 255 gonderirse: kirpma `DOSAGE_MISSING`'e
      // yapildigi icin deger tabloyu sismek yerine kendini disarida birakir.
      await joinFull(participants[0], 0, [255, 1, 1, 1, 1, 1]);

      const id = await disclose();
      const snp0 = await readTable(id, 0);

      expect(snp0.flat().reduce((a, b) => a + b, 0)).to.equal(0);
    });
  });

  // ===================================================================================
  // 7) Nadirlik biti belirli bir SNP'ye ait
  // ===================================================================================

  describe("Nadirlik biti (rapor §4.3)", () => {
    it("YALNIZCA yapilandirilan SNP'ye bakar", async () => {
      // RARE_SNP = 2. Katilimci yalnizca SNP 2'de dozaj 2 tasiyor.
      await joinFull(participants[0], 0, [0, 0, 2, 0, 0, 0]);
      await protocol.connect(participants[0]).requestRarityAssessment();

      const handle = await protocol.rarityHandle(await participants[0].getAddress());
      const result = await fhevm.publicDecrypt([handle]);
      await protocol.confirmRarity(
        await participants[0].getAddress(),
        result.abiEncodedClearValues,
        result.decryptionProof,
      );

      expect(await protocol.isRareCarrier(await participants[0].getAddress())).to.equal(true);
    });

    it("BASKA SNP'de dozaj 2 tasimak nadir yapmaz", async () => {
      // SNP 2 disinda her yerde dozaj 2 — yapilandirilan varyantta degil.
      await joinFull(participants[0], 0, [2, 2, 0, 2, 2, 2]);
      await protocol.connect(participants[0]).requestRarityAssessment();

      const handle = await protocol.rarityHandle(await participants[0].getAddress());
      const result = await fhevm.publicDecrypt([handle]);
      await protocol.confirmRarity(
        await participants[0].getAddress(),
        result.abiEncodedClearValues,
        result.decryptionProof,
      );

      expect(await protocol.isRareCarrier(await participants[0].getAddress())).to.equal(false);
    });
  });
});
