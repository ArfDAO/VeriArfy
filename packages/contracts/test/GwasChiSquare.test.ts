import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect } from "chai";
// @ts-expect-error — JS paketi, tip bildirimi yok.
import { chiSquareTest } from "@veriarfy/study";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/mock-utils";
import type { Signer } from "ethers";
import { protocolFactory } from "./helpers/factories";

/**
 * GWAS — sifreli kontenjans tablosu ve ki-kare (rapor §3.3).
 *
 * # Ne kanitlaniyor
 *
 * Katilimcilarin grubu (hasta/saglikli) ve dozaji (0/1/2) SIFRELI gonderilir.
 * Kontrat, hangi hucrenin arttigini hic ogrenmeden 2x3'luk tabloyu doldurur.
 * Esikli acilimdan sonra 6 sayi cozulur ve ki-kare duz metinde hesaplanir.
 *
 * Testin can alici noktasi: zincirden cozulen tablo, ayni girdilerle
 * BAGIMSIZ olarak hesaplanan tabloyla birebir ayni olmalidir. Aksi halde
 * homomorfik sayim sessizce yanlis hucreye yaziyor demektir.
 */
describe("GWAS ki-kare", () => {
  let owner: Signer;
  let nodeA: Signer;
  let nodeB: Signer;
  let participants: Signer[];

  let protocol: any;
  let protocolAddr: string;

  const CIRCUITS = join(__dirname, "..", "..", "circuits");
  const PROVENANCE_ZKEY = join(CIRCUITS, "build", "data_provenance_final.zkey");

  /**
   * Sentetik kohort: 12 kisi.
   *
   * Vaka grubunda mutasyon tasiyanlar bilincli olarak yogunlastirildi —
   * boylece ki-kare sifirdan farkli cikar ve hesabin gercekten calistigi
   * gorulur. Gercek hasta verisi DEGILDIR.
   */
  const COHORT: { group: 0 | 1; dosage: 0 | 1 | 2 }[] = [
    // Kontrol (saglikli): cogunlukla dozaj 0
    { group: 0, dosage: 0 },
    { group: 0, dosage: 0 },
    { group: 0, dosage: 0 },
    { group: 0, dosage: 1 },
    { group: 0, dosage: 1 },
    { group: 0, dosage: 2 },
    // Vaka (hasta): cogunlukla dozaj 1-2
    { group: 1, dosage: 0 },
    { group: 1, dosage: 1 },
    { group: 1, dosage: 1 },
    { group: 1, dosage: 2 },
    { group: 1, dosage: 2 },
    { group: 1, dosage: 2 },
  ];

  const THRESHOLD = 2;
  const MIN_PARTICIPANTS = COHORT.length;

  before(async () => {
    if (!existsSync(PROVENANCE_ZKEY)) {
      throw new Error("Devre ciktilari yok. Once `npm run circuits:build` calistirin.");
    }
  });

  beforeEach(async () => {
    const signers = await ethers.getSigners();
    [owner, nodeA, nodeB] = signers;
    // Sonuc arastirmaciya gider; kohortun disindan bir adres secilir.
    researcher = signers[signers.length - 1];
    participants = signers.slice(3, 3 + COHORT.length);

    const provenanceLib = await import("@veriarfy/circuits/provenance");
    const { registry } = await provenanceLib.developmentRegistry();

    const Verifier = await ethers.getContractFactory("DataProvenanceVerifier");
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();

    const Protocol = await protocolFactory();
    protocol = await Protocol.deploy(
      await owner.getAddress(),
      THRESHOLD,
      MIN_PARTICIPANTS,
      await verifier.getAddress(),
      registry.root,
    );
    await protocol.waitForDeployment();
    protocolAddr = await protocol.getAddress();

    for (const node of [nodeA, nodeB]) {
      await protocol.connect(owner).authorizeNode(await node.getAddress());
    }
  });

  /** Katilimci grubunu ve dozajini SIFRELI gonderir. */
  async function contribute(signer: Signer, group: number, dosage: number) {
    const enc = await fhevm
      .createEncryptedInput(protocolAddr, await signer.getAddress())
      .add8(group)
      .add8(dosage)
      .encrypt();

    await protocol
      .connect(signer)
      .aggregateDosage(enc.handles[0], enc.handles[1], enc.inputProof);
  }

  /**
   * Esikli acilim sonrasi 6 hucreyi cozer.
   *
   * Rapor §2.6: GWAS "populasyon genetigi analizi" sinifindadir ve 9/10 esik
   * ister. 2 dugumle ceil(2*9/10) = 2, yani her ikisi de onaylamalidir.
   * Rapor §2.5.2: cozum yetkisi ARASTIRMACIYA verilir.
   */
  const GWAS_TYPE = 1;
  let researcher: Signer;

  async function discloseTable(): Promise<number[][]> {
    await protocol.connect(owner).setQueryGateway(await owner.getAddress());
    await protocol
      .connect(owner)
      .requestDisclosure(await researcher.getAddress(), GWAS_TYPE);

    await protocol.connect(nodeA).approveDisclosure(0);
    await protocol.connect(nodeB).approveDisclosure(0);
    // Rapor §2.7.1: esik saglandi; itiraz suresi (burada 0) sonrasi yurutulur.
    await protocol.executeDisclosure(0);

    const handles = await protocol.disclosureContingency(0);

    const table: number[][] = [];
    for (let g = 0; g < 2; g++) {
      const row: number[] = [];
      for (let d = 0; d < 3; d++) {
        const value = await fhevm.userDecryptEuint(
          FhevmType.euint32,
          handles[g][d],
          protocolAddr,
          researcher,
        );
        row.push(Number(value));
      }
      table.push(row);
    }
    return table;
  }

  /** Kohorttan beklenen tabloyu BAGIMSIZ olarak hesaplar. */
  function expectedTable(): number[][] {
    const table = [
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (const row of COHORT) table[row.group][row.dosage] += 1;
    return table;
  }

  /**
   * Ki-kare — duz metinde, cozulmus 6 sayidan.
   *
   * Zincirde hesaplanMAZ: formul bolme icerir ve sifreli bolme TFHE'de
   * pratik degildir. Cozulen sey bireyin verisi degil grup toplamlaridir.
   *
   * ORTAK MOTOR: hesap `packages/study` icindedir; arayuzun arastirma
   * konsolu da AYNI fonksiyonu cagirir. Testin kendi kopyasi olsaydi, iki
   * uygulama sessizce ayrisir ve ekranda gorunen p-degeri testin dogruladigi
   * deger olmazdi.
   */
  function chiSquare(table: number[][]): { chi2: number; df: number; p: number } {
    const result = chiSquareTest(table);
    return { chi2: result.chi2, df: result.df, p: result.p };
  }

  // -----------------------------------------------------------------------------------

  it("sifreli tablo, duz metin tablosuyla BIREBIR ayni", async () => {
    for (const [i, row] of COHORT.entries()) {
      await contribute(participants[i], row.group, row.dosage);
    }

    const onChain = await discloseTable();
    const offChain = expectedTable();

    console.log("\n  Kontenjans tablosu (zincirden cozulmus):");
    console.log(`    kontrol : dozaj0=${onChain[0][0]} dozaj1=${onChain[0][1]} dozaj2=${onChain[0][2]}`);
    console.log(`    vaka    : dozaj0=${onChain[1][0]} dozaj1=${onChain[1][1]} dozaj2=${onChain[1][2]}`);

    expect(onChain).to.deep.equal(offChain);
  });

  it("kucuk kohort ANLAMLILIGA ULASMAZ — GWAS'in temel kisiti", async () => {
    for (const [i, row] of COHORT.entries()) {
      await contribute(participants[i], row.group, row.dosage);
    }

    const { chi2, df } = chiSquare(await discloseTable());

    console.log(`\n  ${COHORT.length} kisi -> χ² = ${chi2.toFixed(4)} (df=${df})`);
    console.log("  kritik deger (df=2, α=0.05) = 5.991 -> ANLAMLI DEGIL");
    console.log("  Rapor §3.3'un tam olarak isaret ettigi sorun: acik veri setleri kucuk.");

    expect(df).to.equal(2);
    expect(chi2).to.be.greaterThan(0);
    expect(chi2).to.be.lessThan(5.991);
  });

  it("buyuk kohortta ayni varyant ANLAMLI cikiyor", async () => {
    // Ayni iliski yapisi, daha buyuk orneklem. VeriArfy'in degeri tam burada:
    // hastane silolarindaki veriyi birlestirerek bu esigi asmak.
    const signers = await ethers.getSigners();
    const big: { group: 0 | 1; dosage: 0 | 1 | 2 }[] = [];
    for (let i = 0; i < 8; i++) {
      for (const row of COHORT) big.push(row);
    }
    const usable = Math.min(big.length, signers.length - 4);

    const Protocol = await protocolFactory();
    const provenanceLib = await import("@veriarfy/circuits/provenance");
    const { registry } = await provenanceLib.developmentRegistry();
    const Verifier = await ethers.getContractFactory("DataProvenanceVerifier");
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();

    protocol = await Protocol.deploy(
      await owner.getAddress(), THRESHOLD, usable,
      await verifier.getAddress(), registry.root,
    );
    await protocol.waitForDeployment();
    protocolAddr = await protocol.getAddress();
    for (const node of [nodeA, nodeB]) {
      await protocol.connect(owner).authorizeNode(await node.getAddress());
    }

    for (let i = 0; i < usable; i++) {
      await contribute(signers[3 + i], big[i].group, big[i].dosage);
    }

    const table = await discloseTable();
    const { chi2, df } = chiSquare(table);

    console.log(`\n  ${usable} kisi -> χ² = ${chi2.toFixed(4)} (df=${df})`);
    console.log(`  sonuc: ${chi2 > 5.991 ? "iliski ANLAMLI (p < 0.05)" : "anlamli degil"}`);
    console.log(`    kontrol : ${table[0].join(" / ")}`);
    console.log(`    vaka    : ${table[1].join(" / ")}`);

    expect(table.flat().reduce((a, b) => a + b, 0)).to.equal(usable);
    expect(chi2).to.be.greaterThan(5.991);
  });

  it("toplam sayim katilimci sayisina esit (hicbir katki kaybolmuyor)", async () => {
    for (const [i, row] of COHORT.entries()) {
      await contribute(participants[i], row.group, row.dosage);
    }

    const table = await discloseTable();
    const total = table.flat().reduce((a, b) => a + b, 0);

    expect(total).to.equal(COHORT.length);
    expect(Number(await protocol.participantCount())).to.equal(COHORT.length);
  });

  it("arali disi grup ve dozaj tabloyu bozamaz", async () => {
    // Kohortun tamami + bir saldirgan: grup 200, dozaj 250.
    for (const [i, row] of COHORT.entries()) {
      await contribute(participants[i], row.group, row.dosage);
    }

    const signers = await ethers.getSigners();
    const attacker = signers[3 + COHORT.length];
    await contribute(attacker, 200, 250);

    const table = await discloseTable();
    const total = table.flat().reduce((a, b) => a + b, 0);

    // DAVRANIS DEGISTI (MK-0013): dozaj artik `DOSAGE_MISSING`e (3) kirpiliyor.
    // Sonuc saldirgan acisindan DAHA IYI: tabloya hic girmiyor. Onceden
    // "vaka + dozaj 2" hucresine dusuyordu, yani uydurma bir gozlem
    // ekliyordu.
    expect(total).to.equal(COHORT.length);
    expect(table).to.deep.equal(expectedTable());
  });

  it("k-anonimlik esigi altinda tablo acilamaz", async () => {
    // Yalnizca 2 katilimci; esik COHORT.length (12).
    await contribute(participants[0], 0, 1);
    await contribute(participants[1], 1, 2);

    await protocol.connect(owner).setQueryGateway(await owner.getAddress());
    await expect(
      protocol.connect(owner).requestDisclosure(await researcher.getAddress(), GWAS_TYPE),
    ).to.be.revertedWithCustomError(protocol, "NotEnoughParticipants");
  });

  it("allel frekansi da hala dogru (havuz toplami korunuyor)", async () => {
    for (const [i, row] of COHORT.entries()) {
      await contribute(participants[i], row.group, row.dosage);
    }

    await protocol.connect(owner).setQueryGateway(await owner.getAddress());
    await protocol
      .connect(owner)
      .requestDisclosure(await researcher.getAddress(), GWAS_TYPE);
    await protocol.connect(nodeA).approveDisclosure(0);
    await protocol.connect(nodeB).approveDisclosure(0);
    // Rapor §2.7.1: esik saglandi; itiraz suresi (burada 0) sonrasi yurutulur.
    await protocol.executeDisclosure(0);

    const poolHandle = await protocol.disclosureSnapshot(0);
    const pool = Number(
      await fhevm.userDecryptEuint(FhevmType.euint32, poolHandle, protocolAddr, researcher),
    );

    const expectedSum = COHORT.reduce((a, r) => a + r.dosage, 0);
    expect(pool).to.equal(expectedSum);

    // Allel frekansi = havuz / (2N) — rapor §3.3.
    const frequency = pool / (2 * COHORT.length);
    console.log(`\n  allel frekansi = ${pool} / (2 x ${COHORT.length}) = ${frequency.toFixed(4)}`);
    expect(frequency).to.be.greaterThan(0).and.lessThan(1);
  });
});
