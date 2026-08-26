/**
 * Tarayici tarafi koken hesaplari, `@veriarfy/circuits` ile AYNI sonucu
 * vermek ZORUNDADIR.
 *
 * ## Neden ayri bir uygulama var
 *
 * Devre paketi Node icindir: `node:crypto`, `circomlibjs`, dosya sistemi.
 * Tarayiciya oldugu gibi tasinamaz. Bu yuzden paketleme, taahhut ve kapsama
 * hesabi web tarafinda ikinci kez yazildi.
 *
 * ## Bu testin yakaladigi sey
 *
 * Iki uygulamanin AYRISMASI. Ayrisma sessizdir ve pahalidir: taahhut tutmaz,
 * kanit uretimi "Error in template DataProvenance" gibi hicbir sey anlatmayan
 * bir hatayla duser. Burada tek satirlik bir farkin bile once yakalanmasi
 * hedeflenir.
 */
import { describe, expect, it } from "vitest";

// Devre paketi duz JS'tir (tip bildirimi yok); testte kasitli olarak `any`
// kullaniliyor — amac tipleri degil DEGERLERI karsilastirmak.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// @ts-expect-error -- tip bildirimi olmayan Node paketi
import * as circuits from "@veriarfy/circuits/provenance";

import {
  DOSAGE_MISSING,
  PANEL_SIZE,
  coverageWords,
  packPanel,
  padPanel,
  panelCommitment,
  provenanceNullifier,
} from "./provenance";

/** Her dozaj degerini — EKSIK dahil — temsil eden gercekci bir panel. */
const PANEL = Array.from({ length: PANEL_SIZE }, (_, i) => [0, 1, 2, 3, 0, 2][i % 6]);

describe("koken hesaplari devre paketiyle ayni", () => {
  it("panel boyutu ve eksik isareti ayni", () => {
    expect(PANEL_SIZE).toBe(circuits.PANEL_SIZE);
    expect(DOSAGE_MISSING).toBe(circuits.DOSAGE_MISSING);
  });

  it("paketleme ayni parcalari uretiyor", () => {
    expect(packPanel(PANEL).map(String)).toEqual(circuits.packPanel(PANEL).map(String));
  });

  it("taahhut ayni", () => {
    const salt = 123456789012345678901234567890n;
    expect(panelCommitment(PANEL, salt).toString()).toBe(
      circuits.panelCommitment(PANEL, salt).toString(),
    );
  });

  it("kapsama kelimeleri ayni", () => {
    expect(coverageWords(PANEL).map(String)).toEqual(
      circuits.coverageWords(PANEL).map(String),
    );
  });

  it("nullifier ayni", () => {
    const commitment = panelCommitment(PANEL, 42n);
    expect(provenanceNullifier(2n, commitment).toString()).toBe(
      circuits.computeProvenanceNullifier(2n, commitment).toString(),
    );
  });
});

describe("dolgu", () => {
  it("calisma paneli devre boyutuna EKSIK ile doldurulur", () => {
    const study = [0, 1, 2];
    const padded = padPanel(study);

    expect(padded).toHaveLength(PANEL_SIZE);
    expect(padded.slice(0, 3)).toEqual(study);
    // 0 ile doldurmak "homozigot referans" demek olurdu ve o alanlar
    // kapsamada VAR gorunurdu — odemenin sisirilmesi.
    expect(new Set(padded.slice(3))).toEqual(new Set([DOSAGE_MISSING]));
  });

  it("dolgu alanlari kapsamada YOK", () => {
    const words = coverageWords(padPanel([0, 1, 2]));
    expect(words[0]).toBe(0b111n);
    expect(words.slice(1).every((w) => w === 0n)).toBe(true);
  });

  it("panelden buyuk girdi reddedilir", () => {
    expect(() => padPanel(Array.from({ length: PANEL_SIZE + 1 }, () => 0))).toThrow();
  });
});
