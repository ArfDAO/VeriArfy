import { describe, expect, it } from "vitest";

import { academicDomain, normalizeEmail, profileSource } from "./verificationRules";

describe("verificationRules (kuratorle ayni kurallar)", () => {
  it("+etiketi atar, kucuk harfe cevirir", () => {
    expect(normalizeEmail("  Ad.Soyad+x@Erciyes.EDU.tr ")).toBe("ad.soyad@erciyes.edu.tr");
  });

  it("kurum alan adini dondurur", () => {
    expect(academicDomain("a@erciyes.edu.tr")).toBe("erciyes.edu.tr");
    expect(academicDomain("a@tip.erciyes.edu.tr")).toBe("erciyes.edu.tr");
  });

  it("kisisel ve ogrenci adreslerini reddeder", () => {
    expect(() => academicDomain("a@gmail.com")).toThrow(/edu\.tr/);
    expect(() => academicDomain("a@ogr.erciyes.edu.tr")).toThrow(/ogrenci/);
    expect(() => academicDomain("a@student.itu.edu.tr")).toThrow(/ogrenci/);
  });

  it("yalniz YOK Akademik ve AVESIS profillerini kabul eder", () => {
    expect(profileSource("http://akademik.yok.gov.tr/AkademikArama/x#a").source).toBe("YOK Akademik");
    expect(profileSource("https://avesis.erciyes.edu.tr/ad.soyad").source).toBe("AVESIS");
    expect(() => profileSource("https://scholar.google.com/x")).toThrow(/YOK/);
    expect(() => profileSource("bir adres")).toThrow(/gecersiz/);
  });
});
