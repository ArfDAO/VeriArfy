/**
 * ZK koken devresi panel buyudukce ne kadar buyuyor?
 *
 * Sistemin geri kalani (Concrete ML) 3892 varyanta cikabildi. Soru: koken
 * kaniti da ayni panele taahhut edebilir mi, yoksa ZK tarafi mi darbogaz?
 *
 * Iki sinir aranir:
 *   1. PAKETLEME SINIRI — taban 4 ile tek bir alan elemanina kac dozaj sigar?
 *      BN254 alani ~254 bit; dozaj basina 2 bit -> yaklasik 127.
 *   2. KISIT SAYISI — panel buyudukce R1CS kisitlari ve ptau ihtiyaci nasil
 *      artiyor?
 *
 * Kullanim:
 *   node scripts/panel-scale-probe.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureCircom } from "./fetch-circom.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TMP = join(ROOT, "build", "panel-probe");

/** BN254 skaler alani 254 bit; dozaj basina 2 bit. */
const PACKING_LIMIT = 1875; // 15 parca x 125 dozaj

const SIZES = [16, 125, 250, 500, 1000, 1875, 2000];

/**
 * Devrenin `main` bileseni OLMAYAN bir kopyasini yazar.
 *
 * `data_provenance.circom` kendi `main`'ini icerir; oldugu gibi include
 * edilirse circom "Multiple main components" der. Sablonu yeniden yazmak
 * yerine dosyanin kendisi kullanilir ve yalnizca son bilesen bildirimi
 * cikarilir — boylece olculen sey URETIM DEVRESIDIR, benzeri degil.
 */
function writeTemplateCopy() {
  const original = readFileSync(join(ROOT, "circuits", "data_provenance.circom"), "utf8");
  const withoutMain = original.replace(
    /component\s+main[\s\S]*?;\s*$/,
    "// (main bileseni sonda kaldirildi — bkz. panel-scale-probe.mjs)\n",
  );
  const path = join(TMP, "provenance_template.circom");
  writeFileSync(path, withoutMain);
  return path;
}

/** Verilen PANEL degeri icin gecici bir ust devre yazar. */
function writeTopLevel(panel) {
  const source = `pragma circom 2.1.9;

include "provenance_template.circom";

component main {public [externalNullifier, cidHigh, cidLow, signalHash]} =
    DataProvenance(${panel}, 20);
`;
  const path = join(TMP, `probe_${panel}.circom`);
  writeFileSync(path, source);
  return path;
}

function compile(circomPath, sourcePath, panel) {
  const outDir = join(TMP, `out_${panel}`);
  mkdirSync(outDir, { recursive: true });

  try {
    const output = execFileSync(
      circomPath,
      [
        sourcePath,
        "--r1cs",
        "-o",
        outDir,
        // Ayni arama yollari `scripts/build.js` ile birebir olmali; eksigi
        // "previous errors were found" gibi sebebi gizleyen bir hata verir.
        "-l",
        TMP,
        "-l",
        join(ROOT, "circuits"),
        "-l",
        join(ROOT, "node_modules"),
        "-l",
        join(ROOT, "..", "..", "node_modules"),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const constraints = /non-linear constraints:\s*(\d+)/i.exec(output);
    const linear = /linear constraints:\s*(\d+)/i.exec(output);
    return {
      ok: true,
      nonLinear: constraints ? Number(constraints[1]) : null,
      linear: linear ? Number(linear[1]) : null,
    };
  } catch (err) {
    const text = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    const lastLine = text.split("\n").filter(Boolean).pop() ?? "(cikti yok)";
    return { ok: false, detail: lastLine.slice(0, 120) };
  }
}

/** Kisit sayisi icin gereken en kucuk ptau ussu. */
function requiredPtau(constraints) {
  let power = 1;
  while (2 ** power < constraints) power++;
  return power;
}

async function main() {
  const circomPath = await ensureCircom();
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeTemplateCopy();

  console.log("ZK koken devresi — panel olcekleme\n");
  console.log(`Paketleme siniri (teorik): ${PACKING_LIMIT} dozaj`);
  console.log("  taban 4 -> dozaj basina 2 bit, BN254 alani ~254 bit\n");

  console.log(`${"panel".padStart(6)} ${"dogrusal olmayan".padStart(17)} ${"dogrusal".padStart(9)} ${"ptau".padStart(6)}`);
  console.log("-".repeat(46));

  for (const panel of SIZES) {
    const sourcePath = writeTopLevel(panel);
    const result = compile(circomPath, sourcePath, panel);

    if (!result.ok) {
      console.log(`${String(panel).padStart(6)} DERLENMEDI — ${result.detail}`);
      continue;
    }

    const ptau = requiredPtau(result.nonLinear ?? 0);
    const warn = panel > PACKING_LIMIT ? "  <-- paketleme sinirinin USTUNDE" : "";
    console.log(
      `${String(panel).padStart(6)} ` +
        `${String(result.nonLinear).padStart(17)} ` +
        `${String(result.linear).padStart(9)} ` +
        `${String(`2^${ptau}`).padStart(6)}${warn}`,
    );
  }

  console.log(
    "\nNOT: 127 ustu artik DERLENMEZ — devreye `assert(PANEL <= 127)` konuldu.\n" +
      "Bu koruma eklenmeden once 128 ve 256 sorunsuz derleniyordu: taban 4\n" +
      "toplami alan modulusunu asiyor, taahhut tersine cevrilemez hale\n" +
      "geliyor ve devre SESSIZCE yanlis oluyordu — kanit uretilir, dogrulanir,\n" +
      "ama gercek paneli temsil etmezdi.\n\n" +
      "Maliyet acisindan sinir yok: 16 -> 125 arasi fark yalnizca ~%1,7.\n" +
      "Devre EdDSA + Merkle tarafindan domine ediliyor; panel neredeyse bedava.",
  );

  rmSync(TMP, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(`Basarisiz: ${err.message}`);
  process.exit(1);
});
