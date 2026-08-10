/**
 * GUVEN AMA DOGRULA
 *
 * Ayni kohort iki bagimsiz hattan gecirilir:
 *
 *   A) DUZ-METIN HATTI  — puanlar ortada, toplamlar dogrudan hesaplanir.
 *   B) FHE HATTI        — puanlar istemcide sifrelenir, zincirde sifreli kalir,
 *                         toplamlar homomorfik birikir, yalnizca grup duzeyindeki
 *                         (n, Σx, Σx²) acilir.
 *
 * Kimlik dogrulamasi GERCEK Groth16 kanitiyla yapilir (snarkjs, zincir uzerinde
 * dogrulanir). Hicbir adim taklit edilmez.
 *
 * Test, iki hattin urettigi 18 tamsayinin ve tum turetilmis istatistiklerin
 * birebir ayni oldugunu iddia eder.
 */
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/mock-utils";
import { existsSync } from "node:fs";
import { join } from "node:path";

const CIRCUITS = join(__dirname, "..", "..", "circuits");
const WASM = join(CIRCUITS, "build", "researcher_identity_js", "researcher_identity.wasm");
const ZKEY = join(CIRCUITS, "build", "researcher_identity_final.zkey");

/** Katilimci sayisi grup basina — COHORT env ile degistirilebilir. */
const PER_GROUP = Number(process.env.COHORT ?? 8);
const EXTERNAL_NULLIFIER = 1n;

describe("Calisma dogrulamasi — duz-metin hatti vs FHE hatti", function () {
  this.timeout(30 * 60 * 1000);

  it("iki hat ayni toplamlari ve ayni istatistigi uretir", async () => {
    if (!existsSync(ZKEY) || !existsSync(WASM)) {
      throw new Error(
        "Devre ciktilari yok. Once `npm run circuits:build` calistirin.",
      );
    }

    const study = await import("@veriarfy/study");
    const circuits = await import("@veriarfy/circuits");
    const snarkjs: any = await import("snarkjs");

    const signers = await ethers.getSigners();
    const deployer = signers[0];

    // ---------------------------------------------------------------- veri
    const cohort = study.makeCohort({
      seed: 20260810,
      groupSizes: [PER_GROUP, PER_GROUP, PER_GROUP],
    });
    const scored = cohort.map((c: any) => study.scoreSubmission(c));
    const participants = signers.slice(1, 1 + scored.length);
    expect(participants.length, "yeterli test cuzdani yok").to.equal(scored.length);

    console.log(`\n  Kohort: ${scored.length} katilimci (grup basina ${PER_GROUP})`);

    // ------------------------------------------------- A) DUZ-METIN HATTI
    const plain = study.runPlaintextPipeline(scored);

    // ----------------------------------------------------------- kurulum
    const Verifier = await ethers.getContractFactory("Groth16Verifier");
    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();

    // Akredite katilimci agaci — gercek Poseidon Merkle agaci.
    const tree = new circuits.IdentityTree();
    const identities = scored.map(() => circuits.createIdentity());
    for (const id of identities) tree.insert(id.commitment);

    const Registry = await ethers.getContractFactory("VeriArfyRegistry");
    const registry = await Registry.deploy(await verifier.getAddress(), tree.root);
    await registry.waitForDeployment();

    const Study = await ethers.getContractFactory("AnxietyStudy");
    const studyContract = await Study.deploy(await registry.getAddress());
    await studyContract.waitForDeployment();
    const studyAddress = await studyContract.getAddress();

    console.log("  Kontratlar hazir. Gercek ZK kaniti uretiliyor…");

    // -------------------------------------------------- B) FHE HATTI
    const t0 = Date.now();
    for (let i = 0; i < scored.length; i++) {
      const participant = participants[i];
      const identity = identities[i];
      const row = scored[i];

      // 1) GERCEK zero-knowledge kanit — kimlik acilmadan uyelik ispati.
      const input = circuits.buildCircuitInput({
        identity,
        tree,
        externalNullifier: EXTERNAL_NULLIFIER,
        signerAddress: participant.address,
      });
      const { proof } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
      const calldata = circuits.toSolidityCalldata(proof);
      const nullifierHash = circuits.computeNullifierHash(
        EXTERNAL_NULLIFIER,
        identity.nullifier,
      );

      await registry
        .connect(participant)
        .register(tree.root, nullifierHash, calldata.a, calldata.b, calldata.c);

      // 2) GERCEK FHE sifreleme — grup, anksiyete ve panik puani birlikte.
      const enc = await fhevm
        .createEncryptedInput(studyAddress, participant.address)
        .add8(row.group)
        .add32(row.anxiety)
        .add32(row.panic)
        .encrypt();

      await studyContract
        .connect(participant)
        .submit(enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof);

      if ((i + 1) % 6 === 0 || i === scored.length - 1) {
        console.log(`    ${i + 1}/${scored.length} katilimci kaydedildi + sifreli gonderdi`);
      }
    }
    console.log(`  FHE hatti tamamlandi (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

    expect(await studyContract.participantCount()).to.equal(scored.length);
    expect(await registry.researcherCount()).to.equal(scored.length);

    // -------------------------------------- toplamlari coz (yalnizca grup duzeyi)
    async function readAggregates(which: "anxiety" | "panic") {
      const out = [];
      for (let g = 0; g < 3; g++) {
        const handles =
          which === "anxiety"
            ? await studyContract.anxietyAggregate(g)
            : await studyContract.panicAggregate(g);
        // Mock koprosesor es zamanli sorgu desteklemez — sirayla coz.
        const clear: bigint[] = [];
        for (const h of [handles[0], handles[1], handles[2]]) {
          clear.push(await fhevm.publicDecryptEuint(FhevmType.euint32, h));
        }
        out.push({
          n: Number(clear[0]),
          sum: Number(clear[1]),
          sumSq: Number(clear[2]),
        });
      }
      return out;
    }

    const fheAggregates = {
      anxiety: await readAggregates("anxiety"),
      panic: await readAggregates("panic"),
    };
    const fheResult = study.analyze(fheAggregates);

    // ------------------------------------------------------- KARSILASTIRMA
    console.log("\n  ── Grup toplamlari: duz-metin vs FHE ──");
    for (const measure of ["anxiety", "panic"] as const) {
      for (let g = 0; g < 3; g++) {
        const p = (plain.aggregates as any)[measure][g];
        const f = (fheAggregates as any)[measure][g];
        console.log(
          `    ${measure.padEnd(7)} grup ${g}: ` +
            `duz(n=${p.n}, Σx=${p.sum}, Σx²=${p.sumSq}) | ` +
            `fhe(n=${f.n}, Σx=${f.sum}, Σx²=${f.sumSq})`,
        );
        expect(f.n, `${measure} g${g} n`).to.equal(p.n);
        expect(f.sum, `${measure} g${g} Σx`).to.equal(p.sum);
        expect(f.sumSq, `${measure} g${g} Σx²`).to.equal(p.sumSq);
      }
    }

    // Turetilmis istatistikler de birebir ayni olmali.
    for (const measure of ["anxiety", "panic"] as const) {
      const p = (plain.result as any)[measure];
      const f = (fheResult as any)[measure];
      expect(f.a.mean).to.equal(p.a.mean);
      expect(f.b.mean).to.equal(p.b.mean);
      expect(f.t).to.equal(p.t);
      expect(f.p).to.equal(p.p);
      expect(f.cohensD).to.equal(p.cohensD);
    }

    // --------------------------------------------------------- CALISMA SONUCU
    const r = plain.result.anxiety;
    const rp = plain.result.panic;
    const g = study.USAGE_GROUPS;

    console.log("\n  ── CALISMA SONUCU (TEST VERISI) ──");
    console.log(`  Anksiyete (Burns, 0–99)`);
    console.log(
      `    ${g[0].label.padEnd(10)} ort=${r.a.mean.toFixed(2)} sd=${r.a.sd.toFixed(2)} n=${r.a.n}`,
    );
    console.log(
      `    ${g[2].label.padEnd(10)} ort=${r.b.mean.toFixed(2)} sd=${r.b.sd.toFixed(2)} n=${r.b.n}`,
    );
    console.log(
      `    fark=${r.meanDiff.toFixed(2)}  t=${r.t.toFixed(3)}  df=${r.df.toFixed(1)}  ` +
        `p=${study.formatP(r.p)}  d=${r.cohensD.toFixed(3)} (${study.effectSizeLabel(r.cohensD)})`,
    );
    console.log(`  Panik (PDSS yapisi, 0–28)`);
    console.log(
      `    fark=${rp.meanDiff.toFixed(2)}  t=${rp.t.toFixed(3)}  ` +
        `p=${study.formatP(rp.p)}  d=${rp.cohensD.toFixed(3)} (${study.effectSizeLabel(rp.cohensD)})`,
    );
    console.log("\n  ✓ Iki hat birebir ayni sonucu uretti.\n");
  });
});
