import { ethers, fhevm } from "hardhat";

import { biomarkersFactory, protocolFactory } from "./helpers/factories";

/**
 * Biyobelirtec kanalinin parti tavani — HCU olcumu.
 *
 * # Neden dozajdan DAHA PAHALI
 *
 * Genomik tarafta katilimci basina metrik islemleri karsilastirma ve toplama
 * agirlikliydi. Burada VARYANS gerekiyor ve varyansin yeterli istatistigi
 * kareler toplamidir — yani her olcum icin bir CARPMA:
 *
 *     mul(euint64, euint64)  = 596.000 HCU   (tek basina)
 *     mul(euint32, euint32)  = 328.000 HCU
 *
 * (Kaynak: `@fhevm/host-contracts/contracts/HCULimit.sol`.)
 *
 * 64 bit secildi cunku olcekli deger 2^20'ye kadar cikabiliyor ve karesi
 * 2^40'tir — 32 bite sigmaz. Sinir `MAX_METRIC_VALUE` olarak kodda durur;
 * daha dar bir sinirla 32 bitte carpilabilirdi ama kreatin kinaz gibi genis
 * araligi olan gercek metrikler disarida kalirdi.
 *
 * Bu dosya bir "gecti/kaldi" testi degil OLCUMDUR: dokumandaki rakamlar
 * buradan gelir.
 */
describe("Biyobelirtec kanali — parti tavani (HCU)", () => {
  /** fhEVM islem basina HCU butcesi. */
  const HCU_LIMIT_PER_TX = 20_000_000;

  it("en buyuk calisan partiyi ve metrik basina maliyeti olcer", async function () {
    this.timeout(900_000);

    const [owner, participant] = await ethers.getSigners();

    /** Verilen parti buyuklugunu dener; HCU asilirsa null doner. */
    async function tryBatch(batch: number): Promise<number | null> {
      const Verifier = await ethers.getContractFactory("DataProvenanceVerifier");
      const verifier = await Verifier.deploy();
      await verifier.waitForDeployment();

      const Protocol = await protocolFactory();
      const protocol = await Protocol.deploy(
        await owner.getAddress(), 1, 1, await verifier.getAddress(), ethers.ZeroHash,
      );
      await protocol.waitForDeployment();
      const protocolAddr = await protocol.getAddress();

      const Biomarkers = await biomarkersFactory();
      const biomarkers = await Biomarkers.deploy(protocolAddr);
      await biomarkers.waitForDeployment();
      const moduleAddr = await biomarkers.getAddress();

      await protocol.connect(owner).setBiomarkerModule(moduleAddr);
      await protocol.connect(owner).configurePanel(1, 0, ethers.ZeroHash, "");

      const specs = Array.from({ length: batch }, (_, i) => ({
        code: ethers.encodeBytes32String(`M${i}`),
        unit: ethers.encodeBytes32String("unit"),
        scale: 100,
        offset: 0,
        minValue: 1,
        maxValue: 1_048_575,
      }));
      await biomarkers.connect(owner).configureMetrics(specs, ethers.ZeroHash, "");

      // Kayit AYRI olculur; parti maliyetine karismasin.
      const groupInput = await fhevm
        .createEncryptedInput(protocolAddr, await participant.getAddress())
        .add8(0)
        .encrypt();
      await protocol
        .connect(participant)
        .enroll(groupInput.handles[0], groupInput.inputProof);

      const builder = fhevm.createEncryptedInput(moduleAddr, await participant.getAddress());
      for (let i = 0; i < batch; i++) builder.add32(1000 + i);
      const enc = await builder.encrypt();

      try {
        const tx = await biomarkers
          .connect(participant)
          .contributeBiomarkers(enc.handles, enc.inputProof);
        const receipt = await tx.wait();
        return Number(receipt!.gasUsed);
      } catch (err: any) {
        // HCU butcesinin asilmasi bir HATA DEGIL, aranan sinirdir.
        if (String(err?.message ?? "").includes("HCUTransactionLimit")) return null;
        throw err;
      }
    }

    console.log("\n    parti   toplam gaz   metrik basina   durum");
    console.log("    ---------------------------------------------");

    let best = 0;
    let bestGas = 0;

    for (const batch of [1, 2, 4, 6, 8, 10, 12, 16]) {
      const gas = await tryBatch(batch);

      if (gas === null) {
        console.log(
          `    ${String(batch).padStart(5)} ${"—".padStart(12)} ${"—".padStart(15)}   HCU ASILDI`,
        );
        break;
      }

      best = batch;
      bestGas = gas;
      console.log(
        `    ${String(batch).padStart(5)} ${gas.toLocaleString("tr").padStart(12)} ` +
          `${Math.round(gas / batch).toLocaleString("tr").padStart(15)}   tamam`,
      );
    }

    console.log(`\n    HCU butcesi (islem basina): ${HCU_LIMIT_PER_TX.toLocaleString("tr")}`);
    console.log(`    en buyuk calisan parti    : ${best} metrik`);
    console.log(`    metrik basina gaz         : ~${Math.round(bestGas / best).toLocaleString("tr")}`);
    console.log(
      `    40 metriklik panel        : ~${Math.ceil(40 / Math.max(best, 1))} islem ` +
        `(katilimci basina, olcum donemi basina)\n`,
    );
  });
});
