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
