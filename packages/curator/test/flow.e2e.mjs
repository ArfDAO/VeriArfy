/**
 * Arastirmaci dogrulamasinin uctan uca testi.
 *
 * Gercek sozlesmeleri YEREL bir dugume dagitir ve kurator sunucusunu gercekten
 * calistirir. E-posta API'si, ORCID ve ROR icin yerel bir yakalayici kullanir;
 * bunlar YALNIZCA bu testte devreye girer (MAIL_API_URL / ORCID_*_URL / ROR_API_URL).
 *
 * Sinananlar: iki dogrulama yolu, tekillik, red durumlari, operator onayinin
 * yalniz POST ile verilmesi ve - en onemlisi - sunucu yeniden baslayinca
 * listenin zincirden geri gelmesi.
 *
 * Calistirma:
 *   cd packages/contracts && npx hardhat compile && npx hardhat node   (ayri terminal)
 *   npm run test:e2e --workspace packages/curator
 *
 * Bu test ilk calistirmada gercek bir hata yakaladi: onayin hemen ardindan
 * gelen kok yazimi onbellekteki eski nonce'u aliyordu (bkz. chain.js).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const HERE = dirname(fileURLToPath(import.meta.url));
const CURATOR_DIR = join(HERE, "..");
const ARTIFACTS = join(HERE, "..", "..", "contracts", "artifacts", "contracts");
const SB = tmpdir();
const RPC = "http://127.0.0.1:8545";
const CURATOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // hardhat #1
const art = (n) => JSON.parse(readFileSync(join(ARTIFACTS, `${n}.sol`, `${n}.json`), "utf8"));

let failures = 0;
const check = (label, cond, extra = "") => { console.log(`${cond ? "  OK " : "  XX "} ${label}${extra ? "  " + extra : ""}`); if (!cond) failures++; };

// 1) sozlesmeler
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(CURATOR_KEY, provider);
const deployer = new ethers.NonceManager(wallet);
const deploy = async (n, args) => { const a = art(n); const c = await new ethers.ContractFactory(a.abi, a.bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c.getAddress(); };
const registry = await deploy("VeriArfyRegistry", ["0x000000000000000000000000000000000000dEaD", 0]);
const log = await deploy("AccreditationLog", [wallet.address]);
writeFileSync(join(SB, "veriarfy-local-deploy.json"), JSON.stringify({ contracts: { VeriArfyRegistry: registry, AccreditationLog: log } }));
console.log("yerel sozlesmeler:", registry, log);

// 2) yakalayici: e-posta API'si, ORCID, ROR
const mails = [];
const ORCID_OF = { good: "0000-0002-1825-0097" };
let nextOrcid = ORCID_OF.good;
const stub = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks).toString();
  const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/emails") { mails.push(JSON.parse(body)); return send({ id: "x" }); }
  if (req.url === "/oauth/token") return send({ orcid: nextOrcid, name: "Test" });
  if (req.url.startsWith("/v3.0/")) return send({ "affiliation-group": [{ summaries: [{ "employment-summary": {
    organization: { name: "Erciyes University", "disambiguated-organization": { "disambiguation-source": "ROR", "disambiguated-organization-identifier": "047g8vk19" } },
    "end-date": null, source: { "source-orcid": { path: "x" } } } }] }] });
  if (req.url.startsWith("/organizations/047g8vk19")) return send({ domains: ["erciyes.edu.tr"], links: [] });
  res.writeHead(404); res.end();
}).listen(8600);

// 3) kurator
const env = { ...process.env, CURATOR_PORT: "8601", CURATOR_PRIVATE_KEY: CURATOR_KEY, SEPOLIA_RPC_URL: RPC,
  CURATOR_DEPLOYMENT_FILE: join(SB, "veriarfy-local-deploy.json"), CURATOR_IDENTITY_SECRET: "t".repeat(48),
  RESEND_API_KEY: "test", MAIL_FROM: "VeriArfy <test@veriarfy.test>", MAIL_API_URL: "http://127.0.0.1:8600/emails",
  ORCID_CLIENT_ID: "APP-TEST", ORCID_CLIENT_SECRET: "sec", ORCID_BASE_URL: "http://127.0.0.1:8600", ORCID_API_URL: "http://127.0.0.1:8600",
  ROR_API_URL: "http://127.0.0.1:8600", PUBLIC_CURATOR_URL: "http://127.0.0.1:8601", WEB_APP_URL: "http://app.test", OPERATOR_EMAIL: "op@veriarfy.test" };
let proc;
async function startCurator() {
  proc = spawn("node", ["src/server.js"], { env, cwd: CURATOR_DIR });
  let out = ""; proc.stdout.on("data", (d) => (out += d)); proc.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 60; i++) { try { await fetch("http://127.0.0.1:8601/root"); return () => out; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  throw new Error("kurator acilmadi:\n" + out);
}
const C = "http://127.0.0.1:8601";
const post = (p, b) => fetch(C + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const lastCodeFor = (to) => { const m = [...mails].reverse().find((x) => x.to[0] === to); return m?.subject.match(/(\d{6})/)?.[1]; };

async function emailSession(email) {
  const s = await post("/verify/email/start", { email });
  if (s.status !== 200) return { error: s };
  // Sunucu adresi normalize ediyor (+etiket atiliyor); kod o adrese gider.
  const code = lastCodeFor(s.body.challenge ? mails.at(-1).to[0] : email);
  const c = await post("/verify/email/confirm", { challenge: s.body.challenge, code });
  return c.body;
}

const logs = await startCurator();
try {
  console.log("\n[durum]");
  const st = await (await fetch(C + "/verify/status")).json();
  check("uc yol da yapilandirilmis", st.email && st.orcid && st.profile, JSON.stringify(st));
  check("acik /enroll kapali (410)", (await post("/enroll", { commitment: "1" })).status === 410);

  console.log("\n[ORCID yolu]");
  const s1 = await emailSession("Ali.Veli+x@Erciyes.edu.tr");
  check("kod e-postaya gitti ve dogrulandi", !!s1.emailSession, s1.email);
  check("e-posta normalize edildi (+etiket atildi)", s1.email === "ali.veli@erciyes.edu.tr");
  const C1 = 1234567890123456789n;
  const st1 = await post("/verify/orcid/start", { emailSession: s1.emailSession, commitment: C1.toString() });
  const state = new URL(st1.body.url).searchParams.get("state");
  check("ORCID giris adresi /authenticate kapsaminda", new URL(st1.body.url).searchParams.get("scope") === "/authenticate");
  const cb = await fetch(`${C}/verify/orcid/callback?code=abc&state=${encodeURIComponent(state)}`, { redirect: "manual" });
  const loc = cb.headers.get("location") ?? "";
  check("ORCID donusu: onaylandi ve uygulamaya yonlendirildi", cb.status === 302 && loc.includes("dogrulama=tamam"), loc);
  check("sonuc adres PARCASINDA (#), sorguda degil", loc.includes("/arastirma/kayit#"));
  check("taahhut listede (/path)", (await fetch(`${C}/path/${C1}`)).status === 200);
  let root = await (await fetch(C + "/root")).json();
  check("kok zincire yazildi", root.chainRoot === root.root && root.size === 1, `size ${root.size}`);

  console.log("\n[tekillik]");
  const again = await post("/verify/email/start", { email: "ali.veli@erciyes.edu.tr" });
  check("ayni e-posta ikinci kez kod alamaz", again.status === 409, again.body.error);
  const s1b = await emailSession("baska.adres@erciyes.edu.tr");
  const st1b = await post("/verify/orcid/start", { emailSession: s1b.emailSession, commitment: "999" });
  const cb2 = await fetch(`${C}/verify/orcid/callback?code=abc&state=${encodeURIComponent(new URL(st1b.body.url).searchParams.get("state"))}`, { redirect: "manual" });
  check("ayni ORCID baska e-postayla reddedildi", (cb2.headers.get("location") ?? "").includes("dogrulama=hata"), decodeURIComponent(cb2.headers.get("location") ?? "").split("sebep=")[1]);
  check("reddedilen taahhut listeye girmedi", (await fetch(`${C}/path/999`)).status === 404);

  console.log("\n[red durumlari]");
  check("gmail reddedildi", (await post("/verify/email/start", { email: "a@gmail.com" })).status === 400);
  check("ogrenci alt alan adi reddedildi", (await post("/verify/email/start", { email: "1@ogr.erciyes.edu.tr" })).status === 400);
  const wrong = await post("/verify/email/start", { email: "yanlis@erciyes.edu.tr" });
  const bad = await post("/verify/email/confirm", { challenge: wrong.body.challenge, code: "000000" === lastCodeFor("yanlis@erciyes.edu.tr") ? "111111" : "000000" });
  check("hatali kod reddedildi", bad.status === 400);

  console.log("\n[YOK Akademik yolu - operator onayi]");
  const s2 = await emailSession("ayse.kaya@erciyes.edu.tr");
  const C2 = 98765432109876543n;
  const sub = await post("/verify/profile/submit", { emailSession: s2.emailSession, commitment: C2.toString(), profileUrl: "https://akademik.yok.gov.tr/AkademikArama/view/x.jsp?a=1" });
  check("basvuru incelemeye alindi", sub.status === 200 && sub.body.status === "pending");
  const opMail = [...mails].reverse().find((m) => m.to[0] === "op@veriarfy.test");
  check("operatore e-posta gitti", !!opMail);
  const approveUrl = opMail.text.match(/(http:\/\/127\.0\.0\.1:8601\/verify\/profile\/approve\?token=\S+)/)[1];
  const page = await fetch(approveUrl);
  const pageHtml = await page.text();
  check("GET yalniz gosterir, onaylamaz", page.status === 200 && pageHtml.includes("<form method=\"post\"") && (await fetch(`${C}/path/${C2}`)).status === 404);
  const token = decodeURIComponent(new URL(approveUrl).searchParams.get("token"));
  const ap = await fetch(approveUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token, decision: "approve" }) });
  check("POST ile onaylandi", ap.status === 200 && (await ap.text()).includes("Onaylandi"));
  check("basvurana onay e-postasi gitti", mails.some((m) => m.to[0] === "ayse.kaya@erciyes.edu.tr" && /onaylandi/.test(m.subject)));
  check("taahhut listede", (await fetch(`${C}/path/${C2}`)).status === 200);
  const ap2 = await fetch(approveUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token, decision: "approve" }) });
  check("ayni onay baglantisi ikinci kez kullanilamaz", ap2.status === 409);

  console.log("\n[yeniden baslatma - disk silinse de liste zincirden gelir]");
  root = await (await fetch(C + "/root")).json();
  const before = root.root;
  proc.kill(); await new Promise((r) => setTimeout(r, 800));
  await startCurator();
  root = await (await fetch(C + "/root")).json();
  check("liste zincirden yeniden kuruldu", root.size === 2 && root.root === before, `size ${root.size}`);
  check("iki taahhut da yolda", (await fetch(`${C}/path/${C1}`)).status === 200 && (await fetch(`${C}/path/${C2}`)).status === 200);
  check("kok hala zincirle ayni", root.chainRoot === root.root);
} finally {
  proc?.kill(); stub.close();
  console.log(`\nSONUC: ${failures === 0 ? "HEPSI GECTI" : failures + " BASARISIZ"}`);
  if (failures) console.log("--- kurator gunlugu ---\n" + logs());
  process.exit(failures ? 1 : 0);
}
