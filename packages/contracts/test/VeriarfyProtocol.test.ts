import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/mock-utils";
import type { Signer } from "ethers";

/**
 * VeriarfyProtocol — FHEVM mock ortaminda uctan uca dogrulama.
 *
 * Kritik sorular:
 *   1. Sifreli dozajlar dogru toplaniyor mu (hic acilmadan)?
 *   2. Arali disi bir dozaj toplami bozabiliyor mu?
 *   3. Esik saglanmadan cozum yetkisi sizabiliyor mu?
 *   4. Yetkisiz bir adres cozebiliyor mu?
 */
describe("VeriarfyProtocol", () => {
  let owner: Signer;
  let nodeA: Signer;
  let nodeB: Signer;
  let nodeC: Signer;
  let alice: Signer;
  let bob: Signer;
  let carol: Signer;
  let outsider: Signer;

  let protocol: any;
  let protocolAddr: string;

  const THRESHOLD = 2; // 2-of-3
  const MIN_PARTICIPANTS = 3;

  /** Gercekci bir panel: 16 SNP dozaji (0 | 1 | 2). */
  const PANEL = [0, 1, 2, 1, 0, 0, 2, 1, 1, 0, 2, 2, 0, 1, 0, 1];

  const CIRCUITS_DIR = join(__dirname, "..", "..", "circuits");
  const PROVENANCE_WASM = join(
    CIRCUITS_DIR, "build", "data_provenance_js", "data_provenance.wasm",
  );
  const PROVENANCE_ZKEY = join(CIRCUITS_DIR, "build", "data_provenance_final.zkey");

  // Devre ciktilari ve akredite kurum kayitlari — testler boyunca sabit.
  let provenance: any;
  let snarkjs: any;
  let registry: any;
  let hospital: any;
  let rogueLab: any;

  before(async () => {
    if (!existsSync(PROVENANCE_ZKEY)) {
      throw new Error(
        "data_provenance devre ciktilari yok. Once `npm run circuits:build` calistirin.",
      );
    }

    provenance = await import("@veriarfy/circuits/provenance");
    snarkjs = await import("snarkjs");

    registry = provenance.createInstitutionRegistry();
    hospital = await provenance.createInstitutionKey();
    rogueLab = await provenance.createInstitutionKey(); // akredite DEGIL
    registry.insert(hospital.leaf);
  });

  beforeEach(async () => {
    [owner, nodeA, nodeB, nodeC, alice, bob, carol, outsider] = await ethers.getSigners();

    const Verifier = await ethers.getContractFactory("DataProvenanceVerifier");
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();

    const Factory = await ethers.getContractFactory("VeriarfyProtocol");
    protocol = await Factory.deploy(
      await owner.getAddress(),
      THRESHOLD,
      MIN_PARTICIPANTS,
      await verifier.getAddress(),
      registry.root,
    );
    await protocol.waitForDeployment();
    protocolAddr = await protocol.getAddress();

    for (const node of [nodeA, nodeB, nodeC]) {
      await protocol.connect(owner).authorizeNode(await node.getAddress());
    }
  });

  /**
   * Bir katilimci icin gercek koken kaniti uretir.
   *
   * Mock yok: kurum paneli gercekten imzalar, snarkjs gercekten kanit uretir,
   * zincirdeki Groth16 dogrulayici gercekten dogrular. Bu yuzden yavastir —
   * ama "kapi gercekten kapi mi" sorusunun tek dogru cevabi budur.
   */
  async function buildProof(
    signer: Signer,
    cidDigest: string,
    options: { institution?: any; signWith?: any; panel?: number[] } = {},
  ) {
    const institution = options.institution ?? hospital;
    const panel = options.panel ?? PANEL;

    const salt = provenance.randomSalt();
    const commitment = provenance.panelCommitment(panel, salt);
    // `signWith` verilirse imza, iddia edilen kurumdan BASKA bir anahtarla
    // atilir — sahte imza senaryosu.
    const signer_ = options.signWith ?? institution;
    const signature = await provenance.signCommitment(signer_.privateKey, commitment);

    const input = provenance.buildProvenanceInput({
      dosages: panel,
      salt,
      institution,
      signature,
      registry,
      // Sozlesmedeki PROVENANCE_SCOPE ile ayni olmali; farkliysa kanit
      // dogrulanmaz (alan ayrimi).
      externalNullifier: 2n,
      cidDigest,
      signerAddress: await signer.getAddress(),
    });

    const { proof } = await snarkjs.groth16.fullProve(input, PROVENANCE_WASM, PROVENANCE_ZKEY);
    const { a, b, c } = (await import("@veriarfy/circuits")).toSolidityCalldata(proof);

    return {
      commitment,
      nullifierHash: provenance.computeProvenanceNullifier(2n, commitment),
      root: registry.root,
      a,
      b,
      c,
    };
  }

  /** Kaniti uretip `submitRecord`'u cagirir. */
  async function submit(signer: Signer, cidDigest: string, options = {}) {
    const p = await buildProof(signer, cidDigest, options);
    return protocol
      .connect(signer)
      .submitRecord(cidDigest, p.root, p.nullifierHash, p.commitment, p.a, p.b, p.c);
  }

  /** Bir katilimci adina sifreli dozaj gonderir. */
  async function aggregate(signer: Signer, dosage: number, group = 0) {
    const enc = await fhevm
      .createEncryptedInput(protocolAddr, await signer.getAddress())
      .add8(group)
      .add8(dosage)
      .encrypt();

    return protocol
      .connect(signer)
      .aggregateDosage(enc.handles[0], enc.handles[1], enc.inputProof);
  }

  /**
   * Acilim talebi acar, esigi doldurur ve havuzu ARASTIRMACI adina cozer.
   *
   * Rapor §2.5.2: talebi kapi acar, dugumler onaylar, sonuc arastirmaciya
   * gider. Birim testte kapi rolunu owner ustlenir.
   */
  async function discloseAndDecrypt(researcher: Signer = outsider): Promise<bigint> {
    const STATISTICS = 4; // 4/10 -> 3 dugumde 2 onay
    await protocol.connect(owner).setQueryGateway(await owner.getAddress());
    await protocol
      .connect(owner)
      .requestDisclosure(await researcher.getAddress(), STATISTICS);

    await protocol.connect(nodeA).approveDisclosure(0);
    await protocol.connect(nodeB).approveDisclosure(0);

    const handle = await protocol.disclosureSnapshot(0);
    return fhevm.userDecryptEuint(FhevmType.euint32, handle, protocolAddr, researcher);
  }

  // -----------------------------------------------------------------------------------
  // IPFS indeksi
  // -----------------------------------------------------------------------------------

  describe("IPFS kayit indeksi", () => {
    const digest = ethers.keccak256(ethers.toUtf8Bytes("sifreli-panel-blobu"));

    it("gecerli koken kanitiyla CID kaydedilir ve sayac artar", async () => {
      await expect(submit(alice, digest))
        .to.emit(protocol, "RecordSubmitted")
        .withArgs(await alice.getAddress(), digest, false);

      expect(await protocol.userCIDs(await alice.getAddress())).to.equal(digest);
      expect(await protocol.recordCount()).to.equal(1);
      // Panelin taahhudu saklanir; panelin kendisi zincire hic girmez.
      expect(await protocol.panelCommitment(await alice.getAddress())).to.not.equal(0);
    });

    it("ayni adres guncelleyince sayac ikinci kez artmaz", async () => {
      const other = ethers.keccak256(ethers.toUtf8Bytes("yeni-blob"));

      await submit(alice, digest);
      await expect(submit(alice, other))
        .to.emit(protocol, "RecordSubmitted")
        .withArgs(await alice.getAddress(), other, true);

      expect(await protocol.recordCount()).to.equal(1);
      expect(await protocol.userCIDs(await alice.getAddress())).to.equal(other);
    });

    it("bos digest reddedilir", async () => {
      const p = await buildProof(alice, digest);
      await expect(
        protocol
          .connect(alice)
          .submitRecord(ethers.ZeroHash, p.root, p.nullifierHash, p.commitment, p.a, p.b, p.c),
      ).to.be.revertedWithCustomError(protocol, "EmptyCid");
    });
  });

  // -----------------------------------------------------------------------------------
  // ZK veri kokeni — kapinin gercekten kapi oldugunu gosteren testler
  // -----------------------------------------------------------------------------------

  describe("ZK veri kokeni kapisi", () => {
    const digest = ethers.keccak256(ethers.toUtf8Bytes("sifreli-panel-blobu"));

    it("kanitsiz veri girisi IMKANSIZ (cop veri savunmasi)", async () => {
      // Gecerli bir kanit olmadan uydurma bilesenlerle deneme.
      const zero: [bigint, bigint] = [0n, 0n];
      await expect(
        protocol
          .connect(outsider)
          .submitRecord(digest, registry.root, 1n, 1n, zero, [zero, zero], zero),
      ).to.be.revertedWithCustomError(protocol, "InvalidProvenanceProof");
    });

    it("sahte imza kanit uretimini bile gecemez", async () => {
      // Saldiri: akredite hastanenin kimligini iddia et, ama imzayi akredite
      // OLMAYAN laboratuvarin anahtariyla at. Merkle kaniti tutar (hastane
      // gercekten agacta) ama EdDSA kisiti kirilir.
      //
      // Savunma devrede oldugu icin saldirgan zincire hic ulasamaz: kanit
      // uretimi (witness) asamasinda duser. Testin dogruladigi sey budur.
      await expect(
        submit(alice, digest, { institution: hospital, signWith: rogueLab }),
      ).to.be.rejected;
    });

    it("akredite olmayan kurum kendi agaciyla da giremez", async () => {
      // Saldiri: sahte laboratuvar KENDI agacini kurar, kendi kokune karsi
      // kusursuz gecerli bir kanit uretir. Kanit matematiksel olarak dogrudur
      // — ama kok kontratin tanidigi kok degildir.
      const rogueRegistry = provenance.createInstitutionRegistry();
      rogueRegistry.insert(rogueLab.leaf);

      const salt = provenance.randomSalt();
      const commitment = provenance.panelCommitment(PANEL, salt);
      const signature = await provenance.signCommitment(rogueLab.privateKey, commitment);

      const input = provenance.buildProvenanceInput({
        dosages: PANEL,
        salt,
        institution: rogueLab,
        signature,
        registry: rogueRegistry,
        externalNullifier: 2n,
        cidDigest: digest,
        signerAddress: await alice.getAddress(),
      });

      const { proof } = await snarkjs.groth16.fullProve(
        input, PROVENANCE_WASM, PROVENANCE_ZKEY,
      );
      const { a, b, c } = (await import("@veriarfy/circuits")).toSolidityCalldata(proof);

      await expect(
        protocol
          .connect(alice)
          .submitRecord(
            digest,
            rogueRegistry.root,
            provenance.computeProvenanceNullifier(2n, commitment),
            commitment,
            a, b, c,
          ),
      ).to.be.revertedWithCustomError(protocol, "UnknownAccreditedRoot");
    });

    it("baskasinin kaniti calinamaz (cuzdana bagli)", async () => {
      // Kanit alice icin uretilir, bob gondermeye calisir.
      const p = await buildProof(alice, digest);
      await expect(
        protocol
          .connect(bob)
          .submitRecord(digest, p.root, p.nullifierHash, p.commitment, p.a, p.b, p.c),
      ).to.be.revertedWithCustomError(protocol, "InvalidProvenanceProof");
    });

    it("kanit baska bir CID'e ilistirilemez", async () => {
      // Kanit bir digest icin uretilir, baska bir digest ile gonderilir.
      const p = await buildProof(alice, digest);
      const otherDigest = ethers.keccak256(ethers.toUtf8Bytes("baska-blob"));

      await expect(
        protocol
          .connect(alice)
          .submitRecord(otherDigest, p.root, p.nullifierHash, p.commitment, p.a, p.b, p.c),
      ).to.be.revertedWithCustomError(protocol, "InvalidProvenanceProof");
    });

    it("ayni imzali kayit iki kez yuklenemez (nullifier)", async () => {
      const p = await buildProof(alice, digest);

      await protocol
        .connect(alice)
        .submitRecord(digest, p.root, p.nullifierHash, p.commitment, p.a, p.b, p.c);

      await expect(
        protocol
          .connect(alice)
          .submitRecord(digest, p.root, p.nullifierHash, p.commitment, p.a, p.b, p.c),
      ).to.be.revertedWithCustomError(protocol, "ProvenanceNullifierSpent");
    });

    it("bilinmeyen kok reddedilir", async () => {
      const p = await buildProof(alice, digest);
      await expect(
        protocol
          .connect(alice)
          .submitRecord(digest, 12345n, p.nullifierHash, p.commitment, p.a, p.b, p.c),
      ).to.be.revertedWithCustomError(protocol, "UnknownAccreditedRoot");
    });

    it("yalnizca sahip akredite kokunu guncelleyebilir", async () => {
      await expect(
        protocol.connect(outsider).updateAccreditedRoot(999n),
      ).to.be.revertedWithCustomError(protocol, "OwnableUnauthorizedAccount");

      await expect(protocol.connect(owner).updateAccreditedRoot(999n)).to.emit(
        protocol,
        "AccreditedRootUpdated",
      );
    });

    it("kapsam ayraci arastirmaci devresininkinden FARKLI (alan ayrimi)", async () => {
      // VeriArfyRegistry.EXTERNAL_NULLIFIER = 1; burada 2 olmali. Ayni olsaydi
      // iki devrenin nullifier'lari ayni uzaya duserdi.
      expect(await protocol.PROVENANCE_SCOPE()).to.equal(2n);
    });
  });

  // -----------------------------------------------------------------------------------
  // Sifreli toplama
  // -----------------------------------------------------------------------------------

  describe("Sifreli dozaj havuzu", () => {
    it("dozajlari hic acmadan dogru toplar (0 + 1 + 2 = 3)", async () => {
      await aggregate(alice, 0);
      await aggregate(bob, 1);
      await aggregate(carol, 2);

      expect(await protocol.participantCount()).to.equal(3);
      expect(await discloseAndDecrypt()).to.equal(3n);
    });

    it("ardisik cagrilar ACL nedeniyle kirilmaz (2 + 2 + 2 = 6)", async () => {
      await aggregate(alice, 2);
      await aggregate(bob, 2);
      await aggregate(carol, 2);

      expect(await discloseAndDecrypt()).to.equal(6n);
    });

    it("arali disi dozaj homomorfik olarak 2'ye kirpilir", async () => {
      // Kotu niyetli istemci 255 gonderiyor; toplam 255 degil 2 artmali.
      await aggregate(alice, 255);
      await aggregate(bob, 1);
      await aggregate(carol, 0);

      expect(await discloseAndDecrypt()).to.equal(3n);
    });

    it("ayni adres iki kez katkida bulunamaz", async () => {
      await aggregate(alice, 1);
      await expect(aggregate(alice, 1)).to.be.revertedWithCustomError(
        protocol,
        "AlreadyAggregated",
      );
    });
  });

  // -----------------------------------------------------------------------------------
  // Esikli cozum
  // -----------------------------------------------------------------------------------

  describe("BSKK-44 esikli erisim (rapor §2.6)", () => {
    // Sorgu tipleri — kontrattaki QUERY_TYPE_* ile ayni.
    const STATISTICS = 4; // rapor: genel istatistik -> 4/10
    const ML = 2;         // rapor: bireysel mutasyon -> 7/10
    const GWAS = 1;       // rapor: populasyon genetigi -> 9/10

    beforeEach(async () => {
      await aggregate(alice, 1);
      await aggregate(bob, 2);
      await aggregate(carol, 1);

      // Rapor §2.5.2: talebi "Gateway" acar. Birim testte kapi rolunu owner
      // ustlenir; uretimde bu adres odeme sozlesmesidir.
      await protocol.connect(owner).setQueryGateway(await owner.getAddress());
    });

    /** Kapi uzerinden arastirmaci adina talep acar. */
    function request(researcher: Signer, queryType: number) {
      return protocol
        .connect(owner)
        .requestDisclosure(researcher.getAddress(), queryType);
    }

    it("kademeli esikler rapordaki oranlari uyguluyor", async () => {
      // 3 yetkili dugum var. Rapor esikleri 10 uzerinden verildigi icin
      // dugum sayisina olceklenir ve YUKARI yuvarlanir.
      expect(await protocol.requiredApprovals(STATISTICS)).to.equal(2); // ceil(3*4/10)
      expect(await protocol.requiredApprovals(ML)).to.equal(3);         // ceil(3*7/10)
      expect(await protocol.requiredApprovals(GWAS)).to.equal(3);       // ceil(3*9/10)
    });

    it("talep acilinca DisclosureRequested yayilir", async () => {
      await expect(request(outsider, STATISTICS))
        .to.emit(protocol, "DisclosureRequested")
        .withArgs(0, await outsider.getAddress(), 3);
    });

    it("kapi disindaki adres talep acamaz", async () => {
      await expect(
        protocol.connect(nodeA).requestDisclosure(await nodeA.getAddress(), STATISTICS),
      ).to.be.revertedWithCustomError(protocol, "NotQueryGateway");
    });

    it("bilinmeyen sorgu tipi reddedilir", async () => {
      await expect(request(outsider, 8)).to.be.revertedWithCustomError(
        protocol,
        "UnknownQueryType",
      );
    });

    it("talebi acan onay VERMEZ — esik dugumlerden gelir", async () => {
      await request(outsider, STATISTICS);

      const status = await protocol.disclosureRequest(0);
      expect(status.finalized).to.equal(false);
      expect(status.approvals).to.equal(0n);
    });

    it("esige ulasilmadan izin VERILMEZ", async () => {
      await request(outsider, STATISTICS);
      await protocol.connect(nodeA).approveDisclosure(0); // 1/2

      expect((await protocol.disclosureRequest(0)).finalized).to.equal(false);

      const handle = await protocol.disclosureSnapshot(0);
      let failed = false;
      try {
        await fhevm.userDecryptEuint(FhevmType.euint32, handle, protocolAddr, outsider);
      } catch {
        failed = true;
      }
      expect(failed, "esik saglanmadan cozum yetkisi sizdi").to.equal(true);
    });

    it("esige ulasinca ARASTIRMACI cozebilir (rapor §2.5.2 adim 6)", async () => {
      await request(outsider, STATISTICS);
      await protocol.connect(nodeA).approveDisclosure(0);
      await expect(protocol.connect(nodeB).approveDisclosure(0))
        .to.emit(protocol, "DisclosureGranted")
        .withArgs(0, 3);

      const handle = await protocol.disclosureSnapshot(0);
      expect(
        await fhevm.userDecryptEuint(FhevmType.euint32, handle, protocolAddr, outsider),
      ).to.equal(4n);
    });

    it("onaylayan dugum sonucu COZEMEZ — sonuc arastirmaciya gider", async () => {
      await request(outsider, STATISTICS);
      await protocol.connect(nodeA).approveDisclosure(0);
      await protocol.connect(nodeB).approveDisclosure(0);

      const handle = await protocol.disclosureSnapshot(0);
      let failed = false;
      try {
        await fhevm.userDecryptEuint(FhevmType.euint32, handle, protocolAddr, nodeA);
      } catch {
        failed = true;
      }
      expect(failed, "onaylayan dugum sonucu gorebildi").to.equal(true);
    });

    it("daha hassas sorgu DAHA COK onay ister", async () => {
      // GWAS (9/10) 3 dugumun ucunu de ister; 2 onay yetmez.
      await request(outsider, GWAS);
      await protocol.connect(nodeA).approveDisclosure(0);
      await protocol.connect(nodeB).approveDisclosure(0);

      expect((await protocol.disclosureRequest(0)).finalized).to.equal(false);

      await protocol.connect(nodeC).approveDisclosure(0);
      expect((await protocol.disclosureRequest(0)).finalized).to.equal(true);
    });

    it("ayni dugum iki kez onaylayamaz (esigi tek basina dolduramaz)", async () => {
      await request(outsider, STATISTICS);
      await protocol.connect(nodeA).approveDisclosure(0);
      await expect(
        protocol.connect(nodeA).approveDisclosure(0),
      ).to.be.revertedWithCustomError(protocol, "AlreadyApproved");
    });

    it("anlik goruntu sonraki katkilardan etkilenmez", async () => {
      await request(outsider, STATISTICS);

      // Talepten sonra yeni katki gelir.
      await aggregate(nodeC, 2);
      expect(await protocol.participantCount()).to.equal(4);

      await protocol.connect(nodeA).approveDisclosure(0);
      await protocol.connect(nodeB).approveDisclosure(0);

      const handle = await protocol.disclosureSnapshot(0);
      const clear = await fhevm.userDecryptEuint(
        FhevmType.euint32, handle, protocolAddr, outsider,
      );

      // Talep anindaki toplam 4 idi; sonradan gelen 2 bu goruntuye girmemeli.
      expect(clear).to.equal(4n);
      expect((await protocol.disclosureRequest(0)).snapshotCount).to.equal(3);
    });
  });

  // -----------------------------------------------------------------------------------
  // k-anonimlik ve yonetim
  // -----------------------------------------------------------------------------------

  describe("Gizlilik sinirlari", () => {
    beforeEach(async () => {
      await protocol.connect(owner).setQueryGateway(await owner.getAddress());
    });

    it("katilimci sayisi esigin altindayken cozum talebi acilamaz", async () => {
      await aggregate(alice, 2);
      // minParticipants = 3, elimizde 1 var: tek kisinin verisi aciga cikardi.
      await expect(
        protocol.connect(owner).requestDisclosure(await outsider.getAddress(), 4),
      )
        .to.be.revertedWithCustomError(protocol, "NotEnoughParticipants")
        .withArgs(1, 3);
    });

    it("bos havuzda talep acilamaz", async () => {
      await expect(
        protocol.connect(owner).requestDisclosure(await outsider.getAddress(), 4),
      ).to.be.revertedWithCustomError(protocol, "PoolEmpty");
    });
  });

  describe("Dugum yonetimi", () => {
    it("yalnizca sahip dugum yetkilendirir", async () => {
      await expect(
        protocol.connect(outsider).authorizeNode(await outsider.getAddress()),
      ).to.be.revertedWithCustomError(protocol, "OwnableUnauthorizedAccount");
    });

    it("esik, kalan dugum sayisinin ustunde kalamaz", async () => {
      // 3 dugum, esik 2. Ikisini kaldirinca esik 1'e cekilmeli, yoksa havuz
      // kalici olarak erisilemez hale gelirdi.
      await protocol.connect(owner).revokeNode(await nodeB.getAddress());
      expect(await protocol.disclosureThreshold()).to.equal(2);

      await protocol.connect(owner).revokeNode(await nodeC.getAddress());
      expect(await protocol.authorizedNodeCount()).to.equal(1);
      expect(await protocol.disclosureThreshold()).to.equal(1);
    });

    it("yetkisi alinan dugum onay veremez", async () => {
      await aggregate(alice, 1);
      await aggregate(bob, 2);
      await aggregate(carol, 1);
      await protocol.connect(owner).setQueryGateway(await owner.getAddress());
      await protocol.connect(owner).requestDisclosure(await outsider.getAddress(), 4);

      await protocol.connect(owner).revokeNode(await nodeA.getAddress());
      await expect(
        protocol.connect(nodeA).approveDisclosure(0),
      ).to.be.revertedWithCustomError(protocol, "NotAuthorizedNode");
    });
  });
});
