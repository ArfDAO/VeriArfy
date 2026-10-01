import assert from "node:assert/strict";
import { test } from "node:test";

import { academicDomain, identityKey, normalizeEmail } from "./identity.js";
import { createChallenge, verifyChallenge } from "./otp.js";
import { signToken, verifyToken } from "./tokens.js";
import { domainMatches, EVIDENCE, matchAffiliation, rorDomains } from "./orcid.js";
import { normalizeProfileUrl } from "./profile.js";

const SECRET = "x".repeat(40);

test("e-posta: buyuk harf ve bosluk normalize edilir", () => {
  assert.equal(normalizeEmail("  Ali.Veli@Erciyes.EDU.tr "), "ali.veli@erciyes.edu.tr");
});

test("e-posta: +etiket atilir, ayni kutu ikinci kimlik acamasin", () => {
  assert.equal(normalizeEmail("ali+1@erciyes.edu.tr"), normalizeEmail("ali+2@erciyes.edu.tr"));
});

test("e-posta: gecersiz adresler reddedilir", () => {
  for (const bad of ["", "ali", "@x.edu.tr", "ali@", "a b@x.edu.tr", "ali@x..edu.tr"]) {
    assert.throws(() => normalizeEmail(bad), undefined, bad);
  }
});

test("kurum alan adi: edu.tr kabul, alt alan adindan kurum cikarilir", () => {
  assert.equal(academicDomain("ali@erciyes.edu.tr"), "erciyes.edu.tr");
  assert.equal(academicDomain("ali@tip.erciyes.edu.tr"), "erciyes.edu.tr");
});

test("kurum alan adi: edu.tr disi reddedilir", () => {
  for (const bad of ["ali@gmail.com", "ali@edu.tr", "ali@erciyes.edu.com", "ali@x.gov.tr"]) {
    assert.throws(() => academicDomain(bad), undefined, bad);
  }
});

test("kurum alan adi: ogrenci alt alan adi reddedilir", () => {
  assert.throws(() => academicDomain("123@ogr.erciyes.edu.tr"), /ogrenci/);
});

test("kimlik ozeti: kararli, turden ve anahtardan bagimli", () => {
  const a = identityKey(SECRET, "email", "ali@x.edu.tr");
  assert.equal(a, identityKey(SECRET, "email", "ali@x.edu.tr"));
  assert.notEqual(a, identityKey(SECRET, "orcid", "ali@x.edu.tr"));
  assert.notEqual(a, identityKey("y".repeat(40), "email", "ali@x.edu.tr"));
  assert.match(a, /^0x[0-9a-f]{64}$/);
});

test("kimlik ozeti: kisa anahtar reddedilir", () => {
  assert.throws(() => identityKey("kisa", "email", "a"), /32/);
});

test("jeton: imza ve tur dogrulanir", () => {
  const t = signToken(SECRET, "email", { email: "a@x.edu.tr" }, 60);
  assert.equal(verifyToken(SECRET, t, "email").email, "a@x.edu.tr");
  assert.throws(() => verifyToken(SECRET, t, "approve"), /tur/);
  assert.throws(() => verifyToken("z".repeat(40), t, "email"), /gecersiz/);
  const [body] = t.split(".");
  assert.throws(() => verifyToken(SECRET, `${body}.AAAA`, "email"), /gecersiz/);
});

test("jeton: suresi dolan reddedilir", () => {
  const t = signToken(SECRET, "email", {}, -1);
  assert.throws(() => verifyToken(SECRET, t, "email"), /suresi/);
});

test("kod: dogru kod e-postayi dondurur, jetondan kod cikarilamaz", () => {
  const { code, challenge } = createChallenge(SECRET, "a@x.edu.tr");
  assert.ok(!challenge.includes(code));
  assert.equal(verifyChallenge(SECRET, challenge, code), "a@x.edu.tr");
});

test("kod: hatali kod reddedilir ve deneme siniri uygulanir", () => {
  const { code, challenge } = createChallenge(SECRET, "b@x.edu.tr");
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) assert.throws(() => verifyChallenge(SECRET, challenge, wrong), /hatali/);
  // 6. deneme dogru kodla bile reddedilir
  assert.throws(() => verifyChallenge(SECRET, challenge, code), /cok fazla/);
});

test("ROR alan adlari: domains + web adresi", () => {
  const d = rorDomains({ domains: ["erciyes.edu.tr"], links: [{ type: "website", value: "https://www.erciyes.edu.tr" }] });
  assert.ok(d.has("erciyes.edu.tr"));
  assert.ok(domainMatches(d, "erciyes.edu.tr"));
  assert.ok(!domainMatches(d, "ege.edu.tr"));
});

const ror = (domains) => ({ domains, links: [] });

test("kurum eslesmesi: ROR alan adi tutarsa beyan kaniti", async () => {
  const r = await matchAffiliation(
    [{ name: "Erciyes University", current: true, disambiguation: { source: "ROR", id: "047g8vk19" }, institutionAsserted: false }],
    "erciyes.edu.tr",
    { rorById: async () => ror(["erciyes.edu.tr"]), rorAffiliation: async () => [] },
  );
  assert.deepEqual([r.matched, r.evidence], [true, EVIDENCE.ORCID_SELF]);
});

test("kurum eslesmesi: kurum sisteminin girdigi kayit daha guclu kanittir", async () => {
  const r = await matchAffiliation(
    [{ name: "Erciyes University", current: true, disambiguation: { source: "ROR", id: "x" }, institutionAsserted: true }],
    "erciyes.edu.tr",
    { rorById: async () => ror(["erciyes.edu.tr"]), rorAffiliation: async () => [] },
  );
  assert.equal(r.evidence, EVIDENCE.ORCID_INSTITUTION);
});

test("kurum eslesmesi: baska universite reddedilir", async () => {
  const r = await matchAffiliation(
    [{ name: "Ege University", current: true, disambiguation: { source: "ROR", id: "x" }, institutionAsserted: true }],
    "erciyes.edu.tr",
    { rorById: async () => ror(["ege.edu.tr"]), rorAffiliation: async () => [] },
  );
  assert.equal(r.matched, false);
});

test("kurum eslesmesi: biten istihdam sayilmaz", async () => {
  const r = await matchAffiliation(
    [{ name: "Erciyes University", current: false, disambiguation: { source: "ROR", id: "x" }, institutionAsserted: true }],
    "erciyes.edu.tr",
    { rorById: async () => ror(["erciyes.edu.tr"]), rorAffiliation: async () => [] },
  );
  assert.equal(r.matched, false);
});

test("kurum eslesmesi: ROR disi kaynakta isimle aranir ama ALAN ADI tutmali", async () => {
  const emp = [{ name: "Erciyes University", current: true, disambiguation: { source: "RINGGOLD", id: "1" }, institutionAsserted: false }];
  const ok = await matchAffiliation(emp, "erciyes.edu.tr", { rorById: async () => null, rorAffiliation: async () => [ror(["erciyes.edu.tr"])] });
  assert.equal(ok.matched, true);
  // isim benzese de alan adi tutmuyorsa kabul edilmez
  const no = await matchAffiliation(emp, "erciyes.edu.tr", { rorById: async () => null, rorAffiliation: async () => [ror(["erciyes.edu"])] });
  assert.equal(no.matched, false);
});

test("profil: YOK Akademik ve AVESIS kabul, digerleri reddedilir", () => {
  assert.equal(normalizeProfileUrl("https://akademik.yok.gov.tr/AkademikArama/view/viewAuthor.jsp?x=1#a").source, "YOK Akademik");
  assert.equal(normalizeProfileUrl("https://avesis.erciyes.edu.tr/ali.veli").source, "AVESIS");
  for (const bad of ["https://scholar.google.com/x", "https://avesis.evil.com/x", "javascript:alert(1)", "yok"]) {
    assert.throws(() => normalizeProfileUrl(bad), undefined, bad);
  }
});
