import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "chai";
import { artifacts } from "hardhat";
import { Fragment, Interface } from "ethers";

/**
 * Arayuzun ABI'si ile dagitilan kontratlar uyusuyor mu?
 *
 * # Bu test neden var
 *
 * `packages/web/src/config/abi.ts` elle yazilmis minimal ABI parcalari tutar.
 * Kontrat imzasi degistiginde TypeScript BUNU YAKALAMAZ: ABI yalnizca bir
 * string dizisidir. Sonuc, calisma zamaninda ortaya cikan sessiz bir kirilma
 * olur — panel bos veri gosterir ya da islem revert eder.
 *
 * Bu tam olarak bir kez yasandi: `submitRecord(bytes32)` koken kanitini
 * alacak sekilde degistirildi, arayuz eski imzayi tutmaya devam etti ve
 * derleme yine de gecti.
 *
 * Test, arayuzdeki her imzanin derlenmis artefaktta GERCEKTEN var oldugunu
 * dogrular. Bir imza degisirse burasi kirilir.
 */
describe("Web ABI senkronizasyonu", () => {
  const ABI_PATH = join(__dirname, "..", "..", "web", "src", "config", "abi.ts");

  /**
   * `abi.ts` icindeki adlandirilmis dizileri cikarir.
   *
   * Dosya sade string literal'lardan olustugu icin metin ayristirmasi yeterli;
   * TypeScript derleyicisini devreye sokmak bu testi kirilgan hale getirirdi.
   */
  function readAbiGroups(): Record<string, string[]> {
    const source = readFileSync(ABI_PATH, "utf8");
    const groups: Record<string, string[]> = {};

    const blockPattern = /export const (\w+) = \[([\s\S]*?)\] as const;/g;
    for (const match of source.matchAll(blockPattern)) {
      const [, name, body] = match;

      // Yorum satirlari once atilir: icinde tirnak gecen bir aciklama
      // ("tablo hazir mi" gibi) aksi halde ABI girdisi saniliyor ve test
      // anlasilmaz bir ethers hatasiyla duruyordu.
      const withoutComments = body
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");

      groups[name] = [...withoutComments.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    }

    return groups;
  }

  /** Derlenmis artefaktin imza kumesi (fonksiyon + olay). */
  async function signaturesOf(contractName: string): Promise<Set<string>> {
    const artifact = await artifacts.readArtifact(contractName);
    const iface = new Interface(artifact.abi);

    const signatures = new Set<string>();
    iface.forEachFunction((fn) => signatures.add(fn.format("sighash")));
    iface.forEachEvent((ev) => signatures.add(ev.format("sighash")));
    return signatures;
  }

  /** Arayuzdeki insan-okunur imzayi kanonik `ad(tipler)` bicimine cevirir. */
  function canonical(humanReadable: string): string {
    return Fragment.from(humanReadable).format("sighash");
  }

  const MAPPING: Record<string, string> = {
    PROTOCOL_ABI: "VeriarfyProtocol",
    PAYMENTS_ABI: "VeriarfyPayments",
    REGISTRY_ABI: "VeriArfyRegistry",
    STUDY_ABI: "AnxietyStudy",
    ERC20_ABI: "StableTestToken",
  };

  it("abi.ts icindeki her grup bir kontrata esleniyor", () => {
    const groups = readAbiGroups();
    expect(Object.keys(groups).length).to.be.greaterThan(0);

    for (const name of Object.keys(groups)) {
      expect(MAPPING, `abi.ts'te eslenmemis grup: ${name}`).to.have.property(name);
    }
  });

  for (const [group, contractName] of Object.entries(MAPPING)) {
    it(`${group} imzalari ${contractName} ile uyusuyor`, async () => {
      const entries = readAbiGroups()[group];
      expect(entries, `${group} bulunamadi`).to.not.equal(undefined);

      const deployed = await signaturesOf(contractName);

      for (const entry of entries) {
        const signature = canonical(entry);
        expect(
          deployed.has(signature),
          `${contractName} icinde yok: ${signature}\n` +
            `  Arayuz su imzayi bekliyor: ${entry}\n` +
            "  Kontrat degistiyse packages/web/src/config/abi.ts guncellenmelidir.",
        ).to.equal(true);
      }
    });
  }

  it("deployment.json'daki adresler arayuz ile ayni", () => {
    const chain = JSON.parse(
      readFileSync(join(__dirname, "..", "deployments", "sepolia.json"), "utf8"),
    );
    const web = JSON.parse(
      readFileSync(
        join(__dirname, "..", "..", "web", "src", "config", "deployment.json"),
        "utf8",
      ),
    );

    expect(web.contracts).to.deep.equal(chain.contracts);
  });
});
