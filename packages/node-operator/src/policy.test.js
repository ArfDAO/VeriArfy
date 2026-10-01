import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateRequest } from "./policy.js";

const ok = {
  requestId: 1,
  requester: "0x45A1613318385E44901A2fA31d1C61d676d4A0f9",
  snapshotCount: 10,
  minParticipants: 10,
  finalized: false,
  revoked: false,
  executed: false,
  isAuthorizedNode: true,
  hasApproved: false,
  canApprove: true,
};

test("kurallara uyan talep onaylanir", () => {
  assert.equal(evaluateRequest(ok).approve, true);
});

test("kohort esigin altindaysa REDDEDILIR", () => {
  const r = evaluateRequest({ ...ok, snapshotCount: 9 });
  assert.equal(r.approve, false);
  assert.match(r.reason, /k-anonimlik/);
});

test("teminatsiz dugum onay veremez", () => {
  assert.equal(evaluateRequest({ ...ok, canApprove: false }).approve, false);
});

test("yetkisiz cuzdan onay veremez", () => {
  assert.equal(evaluateRequest({ ...ok, isAuthorizedNode: false }).approve, false);
});

test("ayni dugum iki kez onaylamaz", () => {
  assert.equal(evaluateRequest({ ...ok, hasApproved: true }).approve, false);
});

test("itirazla iptal edilmis talep onaylanmaz", () => {
  assert.equal(evaluateRequest({ ...ok, revoked: true }).approve, false);
});

test("zaten yurutulmus talep onaylanmaz", () => {
  assert.equal(evaluateRequest({ ...ok, executed: true }).approve, false);
});

test("zaten esige ulasmis talep icin bos islem gonderilmez", () => {
  assert.equal(evaluateRequest({ ...ok, finalized: true }).approve, false);
});

test("var olmayan talep onaylanmaz", () => {
  const r = evaluateRequest({ ...ok, requester: "0x0000000000000000000000000000000000000000" });
  assert.equal(r.approve, false);
});

import { evaluateDifferencing } from "./policy.js";

const req = (fields) => ({ fields: fields.map(([key, count]) => ({ key, count })) });
const other = (requestId, fields) => ({ requestId, fields: fields.map(([key, count]) => ({ key, count })) });

test("fark: onceki talep yoksa onaylanir", () => {
  assert.equal(evaluateDifferencing(req([["snp:0", 10]]), [], 10).approve, true);
});

test("fark: ayni kohort (fark 0) sizinti degildir", () => {
  assert.equal(evaluateDifferencing(req([["snp:0", 10]]), [other(0, [["snp:0", 10]])], 10).approve, true);
});

test("fark: TEK kisilik fark reddedilir - o kisinin genotipi olurdu", () => {
  const r = evaluateDifferencing(req([["snp:0", 11]]), [other(0, [["snp:0", 10]])], 10);
  assert.equal(r.approve, false);
  assert.match(r.reason, /1 kisilik fark/);
});

test("fark: esik kadar fark (k) kabul edilir", () => {
  assert.equal(evaluateDifferencing(req([["snp:0", 20]]), [other(0, [["snp:0", 10]])], 10).approve, true);
});

test("fark: ortak alan yoksa karsilastirilmaz", () => {
  assert.equal(evaluateDifferencing(req([["snp:4", 11]]), [other(0, [["snp:0", 10]])], 10).approve, true);
});

test("fark: toplam havuz buyuk olsa da ALAN bazinda kucuk fark reddedilir", () => {
  // 15 kisi eklendi ama yalnizca 2'si snp:3'u kapsiyor - snp:3 tablosu 2 kisiyi aciga cikarir
  const r = evaluateDifferencing(
    req([["snp:0", 25], ["snp:3", 12]]),
    [other(0, [["snp:0", 10], ["snp:3", 10]])],
    10,
  );
  assert.equal(r.approve, false);
  assert.match(r.reason, /snp:3/);
});

test("fark: metrik alanlari da kontrol edilir", () => {
  assert.equal(evaluateDifferencing(req([["metric:2", 13]]), [other(3, [["metric:2", 10]])], 10).approve, false);
});
