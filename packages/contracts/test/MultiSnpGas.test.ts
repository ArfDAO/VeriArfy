import { ethers, fhevm } from "hardhat";
import { fullCoverage, protocolFactory } from "./helpers/factories";

/**
 * Cok SNP'li GWAS'in gercek siniri: HCU — rapor §3.3.
 *
 * # Beklenmedik bulgu
 *
 * Parti buyuklugunu blok GAZ limiti belirlemiyor. fhEVM'in kendi butcesi var:
 *
 *     MAX_HOMOMORPHIC_COMPUTE_UNITS_PER_TX       = 20.000.000
 *     MAX_HOMOMORPHIC_COMPUTE_UNITS_DEPTH_PER_TX =  5.000.000
 *
 * (Kaynak: `@fhevm/host-contracts/contracts/HCULimit.sol`.)
 *
 * Bu butce EVM gazindan AYRI ve daha sikidir: islem gaz acisindan rahatca
 * sigsa bile `HCUTransactionLimitExceeded` ile duser. Gercek veriyle
 * karsilasilacak ilk duvar budur, blok limiti degil.
 *
 * Bu dosya bir "gecti/kaldi" testi degil OLCUMDUR: en buyuk calisan partiyi
 * ve SNP basina maliyeti gercek islemlerle bulur. Dokumandaki rakamlar
 * buradan gelir.
 */
describe("Cok SNP'li GWAS — parti tavani (HCU)", () => {
  /** fhEVM islem basina HCU butcesi. */
  const HCU_LIMIT_PER_TX = 20_000_000;

  it("en buyuk calisan partiyi ve SNP basina maliyeti olcer", async function () {
    this.timeout(900_000);

    const [owner, participant] = await ethers.getSigners();

    /** Verilen parti buyuklugunu dener; basarisizsa null doner. */
    async function tryBatch(batch: number): Promise<number | null> {
      const Verifier = await ethers.getContractFactory("DataProvenanceVerifier");
      const verifier = await Verifier.deploy();
      await verifier.waitForDeployment();

      const Protocol = await protocolFactory();
      const protocol = await Protocol.deploy(
        await owner.getAddress(), 1, 1, await verifier.getAddress(), ethers.ZeroHash,
      );
      await protocol.waitForDeployment();
      const addr = await protocol.getAddress();

      await protocol.connect(owner).configurePanel(batch, 0, ethers.ZeroHash, "");

      // Kayit AYRI olculur; parti maliyetine karismasin.
      const groupInput = await fhevm
        .createEncryptedInput(addr, await participant.getAddress())
        .add8(0)
        .encrypt();
      await protocol
        .connect(participant)
        .enroll(groupInput.handles[0], groupInput.inputProof);

      const builder = fhevm.createEncryptedInput(addr, await participant.getAddress());
      for (let i = 0; i < batch; i++) builder.add8(i % 3);
      const enc = await builder.encrypt();

      try {
        const tx = await protocol
          .connect(participant)
          .contributeDosages(enc.handles, fullCoverage(batch), enc.inputProof);
        const receipt = await tx.wait();
        return Number(receipt!.gasUsed);
      } catch (err: any) {
        // HCU butcesinin asilmasi bir HATA DEGIL, aranan sinirdir.
        if (String(err?.message ?? "").includes("HCUTransactionLimit")) return null;
        throw err;
      }
    }

    console.log("\n    parti   toplam gaz   SNP basina   durum");
    console.log("    ------------------------------------------");

    let best = 0;
    let bestGas = 0;

    for (const batch of [1, 2, 3, 4, 6, 8, 12, 16]) {
      const gas = await tryBatch(batch);

      if (gas === null) {
        console.log(`    ${String(batch).padStart(5)} ${"—".padStart(12)} ${"—".padStart(12)}   HCU ASILDI`);
        break;
      }

      best = batch;
      bestGas = gas;
      console.log(
        `    ${String(batch).padStart(5)} ${gas.toLocaleString("tr").padStart(12)} ` +
          `${Math.round(gas / batch).toLocaleString("tr").padStart(12)}   tamam`,
      );
    }

    const perSnp = Math.round(bestGas / best);

    console.log(`\n    HCU butcesi (islem basina): ${HCU_LIMIT_PER_TX.toLocaleString("tr")}`);
    console.log(`    en buyuk calisan parti    : ${best} SNP`);
    console.log(`    SNP basina gaz            : ~${perSnp.toLocaleString("tr")}`);
    console.log(
      `    1000 SNP'lik panel        : ~${Math.ceil(1000 / best)} islem ` +
        `(katilimci basina, bir kerelik)\n`,
    );
  });
});
