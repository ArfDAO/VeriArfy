/**
 * Arastirmaci dogrulama uclari.
 *
 *   1. POST /verify/email/start    { email }                    -> kod e-postayla gider
 *   2. POST /verify/email/confirm  { challenge, code }          -> e-posta oturumu
 *   3a. POST /verify/orcid/start   { emailSession, commitment } -> ORCID giris adresi
 *       GET  /verify/orcid/callback                             -> otomatik onay, uygulamaya donus
 *   3b. POST /verify/profile/submit { emailSession, commitment, profileUrl }
 *       GET/POST /verify/profile/approve                        -> operator incelemesi
 *   GET /verify/status                                          -> hangi yollar acik
 *
 * Sunucu durum tutmaz; her adimin sonucu imzali bir jetondur (bkz. tokens.js).
 */
import { academicDomain, identityKey, normalizeEmail } from "./identity.js";
import { mailerConfigured, sendMail } from "./mailer.js";
import { authorizeUrl, EVIDENCE, exchangeCode, fetchEmployments, matchAffiliation } from "./orcid.js";
import { OTP_TTL_SECONDS, createChallenge, verifyChallenge } from "./otp.js";
import { normalizeProfileUrl } from "./profile.js";
import { signToken, verifyToken } from "./tokens.js";

const SNARK_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const EMAIL_SESSION_TTL = 30 * 60;
const ORCID_STATE_TTL = 15 * 60;
const APPROVAL_TTL = 7 * 24 * 60 * 60;

function config() {
  return {
    secret: process.env.CURATOR_IDENTITY_SECRET ?? "",
    publicUrl: (process.env.PUBLIC_CURATOR_URL ?? "").replace(/\/$/, ""),
    webAppUrl: (process.env.WEB_APP_URL ?? "https://veri-arfy.vercel.app").replace(/\/$/, ""),
    orcidClientId: process.env.ORCID_CLIENT_ID ?? "",
    orcidClientSecret: process.env.ORCID_CLIENT_SECRET ?? "",
    operatorEmail: process.env.OPERATOR_EMAIL ?? "",
  };
}

/** Hangi dogrulama yollari calisabilir durumda - arayuz bunu gosterir. */
export function verificationStatus(chain) {
  const c = config();
  const base = chain.verificationReady && c.secret.length >= 32 && mailerConfigured();
  return {
    email: base,
    orcid: base && Boolean(c.orcidClientId && c.orcidClientSecret && c.publicUrl),
    profile: base && Boolean(c.operatorEmail && c.publicUrl),
  };
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseCommitment(raw) {
  let value;
  try {
    value = BigInt(raw);
  } catch {
    throw fail(400, "gecersiz taahhut");
  }
  if (value <= 0n || value >= SNARK_FIELD) throw fail(400, "gecersiz taahhut");
  return value;
}

/* Kaba hiz siniri - bellekte; sunucu uyuyunca sifirlanmasi kabul edilebilir. */
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 50_000) hits.clear();
  return recent.length > max;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function html(res, status, title, body) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#1d2a2a;background:#f7f7f4}
h1{font-size:20px}dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px}dt{color:#5b6b6b}dd{margin:0;overflow-wrap:anywhere}
button{font:inherit;padding:8px 16px;margin-right:8px;border-radius:6px;border:1px solid #1d2a2a;cursor:pointer}
.ok{background:#2f7568;color:#fff;border-color:#2f7568}.warn{background:#fff}</style></head><body>${body}</body></html>`);
}

async function ensureFresh(chain, keys, commitment) {
  for (const key of keys) {
    if (key && (await chain.isUsed(key))) {
      throw fail(409, "bu e-posta ya da profil ile zaten bir arastirmaci kimligi olusturulmus");
    }
  }
  if (await chain.isListed(commitment)) throw fail(409, "bu kimlik zaten listede");
}

/**
 * @param {object} deps
 * @param {ReturnType<import("../chain.js").connect>} deps.chain
 * @param {(commitment: bigint) => Promise<void>} deps.onAccredited  agaci guncelleyip koku yazar
 * @returns {(req, res, url, helpers) => Promise<boolean>}  istegi isledi mi
 */
export function createVerificationRoutes({ chain, onAccredited }) {
  async function accredit(commitment, email, profileKind, profileValue, evidence) {
    const c = config();
    const emailKey = identityKey(c.secret, "email", email);
    const profileKey = profileValue ? identityKey(c.secret, profileKind, profileValue) : "0x" + "0".repeat(64);
    await ensureFresh(chain, [emailKey, profileValue ? profileKey : null], commitment);
    const hash = await chain.accredit(commitment, emailKey, profileKey, evidence);
    await onAccredited(commitment);
    return hash;
  }

  return async function handle(req, res, url, { json, readBody }) {
    if (!url.pathname.startsWith("/verify/")) return false;
    const c = config();
    const status = verificationStatus(chain);
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "?";

    try {
      if (req.method === "GET" && url.pathname === "/verify/status") {
        json(res, 200, status);
        return true;
      }

      // ---------------------------------------------------------------- e-posta
      if (req.method === "POST" && url.pathname === "/verify/email/start") {
        if (!status.email) throw fail(503, "e-posta dogrulamasi henuz yapilandirilmadi");
        const body = await readBody(req);
        const email = normalizeEmail(body.email);
        const domain = academicDomain(email);
        // Hem adres hem kaynak bazinda sinir: sistem baskalarinin kutusuna
        // toplu e-posta gondermek icin kullanilamamali.
        if (limited(`ip:${ip}`, 8, 10 * 60_000) || limited(`mail:${email}`, 3, 10 * 60_000)) {
          throw fail(429, "cok fazla istek; birkac dakika sonra yeniden deneyin");
        }
        if (await chain.isUsed(identityKey(c.secret, "email", email))) {
          throw fail(409, "bu e-posta ile zaten bir arastirmaci kimligi olusturulmus");
        }
        const { code, challenge } = createChallenge(c.secret, email);
        await sendMail({
          to: email,
          subject: `VeriArfy dogrulama kodu: ${code}`,
          text:
            `VeriArfy arastirmaci dogrulama kodunuz: ${code}\n\n` +
            `Kod ${OTP_TTL_SECONDS / 60} dakika gecerlidir. Bu istegi siz yapmadiysaniz bu e-postayi ` +
            `yok sayabilirsiniz; kod girilmedikce hicbir kayit olusmaz.`,
        });
        json(res, 200, { challenge, domain, expiresIn: OTP_TTL_SECONDS });
        return true;
      }

      if (req.method === "POST" && url.pathname === "/verify/email/confirm") {
        const body = await readBody(req);
        if (limited(`confirm:${ip}`, 20, 10 * 60_000)) throw fail(429, "cok fazla deneme");
        const email = verifyChallenge(c.secret, body.challenge, body.code);
        const emailSession = signToken(c.secret, "email", { email }, EMAIL_SESSION_TTL);
        json(res, 200, { emailSession, email, domain: academicDomain(email) });
        return true;
      }

      // ---------------------------------------------------------------- ORCID
      if (req.method === "POST" && url.pathname === "/verify/orcid/start") {
        if (!status.orcid) throw fail(503, "ORCID ile dogrulama henuz yapilandirilmadi");
        const body = await readBody(req);
        const { email } = verifyToken(c.secret, body.emailSession, "email");
        const commitment = parseCommitment(body.commitment);
        const state = signToken(c.secret, "orcid", { email, commitment: commitment.toString() }, ORCID_STATE_TTL);
        json(res, 200, {
          url: authorizeUrl({ clientId: c.orcidClientId, redirectUri: `${c.publicUrl}/verify/orcid/callback`, state }),
        });
        return true;
      }

      if (req.method === "GET" && url.pathname === "/verify/orcid/callback") {
        // Sonuc uygulamaya adres parcasi (#) ile doner: parca sunucuya
        // gonderilmez, sunucu gunluklerine ya da yonlendirme kayitlarina dusmez.
        const back = (params) => {
          res.writeHead(302, { location: `${c.webAppUrl}/arastirma/kayit#${new URLSearchParams(params)}` });
          res.end();
        };
        try {
          if (url.searchParams.get("error")) throw fail(400, "ORCID girisi iptal edildi");
          const { email, commitment } = verifyToken(c.secret, url.searchParams.get("state"), "orcid");
          const { orcid } = await exchangeCode({
            clientId: c.orcidClientId,
            clientSecret: c.orcidClientSecret,
            redirectUri: `${c.publicUrl}/verify/orcid/callback`,
            code: url.searchParams.get("code") ?? "",
          });
          const match = await matchAffiliation(await fetchEmployments(orcid), academicDomain(email));
          if (!match.matched) {
            throw fail(
              422,
              "ORCID kaydinizda bu e-posta adresinin kurumunda guncel bir istihdam bulunamadi. " +
                "ORCID'e istihdam bilginizi ekleyebilir ya da YOK Akademik / AVESIS profiliyle devam edebilirsiniz",
            );
          }
          await accredit(BigInt(commitment), email, "orcid", orcid, match.evidence);
          back({ dogrulama: "tamam", yol: "orcid", kanit: String(match.evidence) });
        } catch (error) {
          back({ dogrulama: "hata", sebep: error.message });
        }
        return true;
      }

      // ------------------------------------------------- YOK Akademik / AVESIS
      if (req.method === "POST" && url.pathname === "/verify/profile/submit") {
        if (!status.profile) throw fail(503, "profil incelemesi henuz yapilandirilmadi");
        const body = await readBody(req);
        const { email } = verifyToken(c.secret, body.emailSession, "email");
        const commitment = parseCommitment(body.commitment);
        const profile = normalizeProfileUrl(body.profileUrl);
        if (limited(`profile:${email}`, 3, 60 * 60_000)) throw fail(429, "cok fazla basvuru; bir saat sonra deneyin");
        await ensureFresh(
          chain,
          [identityKey(c.secret, "email", email), identityKey(c.secret, "profile", profile.url)],
          commitment,
        );
        const token = signToken(
          c.secret,
          "approve",
          { email, commitment: commitment.toString(), profileUrl: profile.url, source: profile.source },
          APPROVAL_TTL,
        );
        await sendMail({
          to: c.operatorEmail,
          subject: `VeriArfy arastirmaci basvurusu: ${email}`,
          text:
            `Dogrulanmis kurum e-postasi: ${email}\n${profile.source} profili: ${profile.url}\n\n` +
            `Profilin bu kisiye ait oldugunu ve akademik unvanini kontrol edin; profilde e-posta ` +
            `gorunuyorsa yukaridaki adresle eslesmeli.\n\n` +
            `Incele ve karar ver: ${c.publicUrl}/verify/profile/approve?token=${encodeURIComponent(token)}\n\n` +
            `Baglanti 7 gun gecerlidir.`,
        });
        json(res, 200, { status: "pending" });
        return true;
      }

      if (url.pathname === "/verify/profile/approve") {
        // GET yalnizca GOSTERIR; karar POST ile verilir. E-posta guvenlik
        // tarayicilari baglantilari onceden acabiliyor - GET ile onaylansaydi
        // bir tarayici basvuruyu kendiliginden onaylayabilirdi.
        if (req.method === "GET") {
          const token = url.searchParams.get("token") ?? "";
          const p = verifyToken(c.secret, token, "approve");
          html(res, 200, "Arastirmaci basvurusu", `
<h1>Arastirmaci basvurusu</h1>
<dl><dt>Kurum e-postasi</dt><dd>${escapeHtml(p.email)} <small>(kodla dogrulandi)</small></dd>
<dt>Profil (${escapeHtml(p.source)})</dt><dd><a href="${escapeHtml(p.profileUrl)}" rel="noreferrer noopener" target="_blank">${escapeHtml(p.profileUrl)}</a></dd></dl>
<p>Profilin bu kisiye ait oldugunu ve kisinin akademik personel oldugunu kontrol edin. Profilde e-posta
gorunuyorsa yukaridaki adresle eslesmelidir. Onay, kisiyi akredite listeye <strong>tek bir kimlikle</strong> ekler.</p>
<form method="post"><input type="hidden" name="token" value="${escapeHtml(token)}">
<button class="ok" name="decision" value="approve">Onayla</button>
<button class="warn" name="decision" value="reject">Reddet</button></form>`);
          return true;
        }
        if (req.method === "POST") {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const form = new URLSearchParams(Buffer.concat(chunks).toString());
          const p = verifyToken(c.secret, form.get("token") ?? "", "approve");
          if (form.get("decision") !== "approve") {
            await sendMail({
              to: p.email,
              subject: "VeriArfy arastirmaci basvurunuz",
              text: "Profil incelemesi sonucunda basvurunuz onaylanmadi. ORCID ile dogrulamayi deneyebilirsiniz.",
            }).catch(() => {});
            html(res, 200, "Reddedildi", "<h1>Basvuru reddedildi</h1><p>Basvuru sahibine bildirildi.</p>");
            return true;
          }
          const hash = await accredit(BigInt(p.commitment), p.email, "profile", p.profileUrl, EVIDENCE.MANUAL);
          await sendMail({
            to: p.email,
            subject: "VeriArfy arastirmaci basvurunuz onaylandi",
            text: `Basvurunuz onaylandi. ${c.webAppUrl}/arastirma/kayit adresine donup ZK kaydinizi tamamlayabilirsiniz.`,
          }).catch(() => {});
          html(res, 200, "Onaylandi", `<h1>Onaylandi</h1><p>Kisi akredite listeye eklendi.</p><p><small>Islem: ${escapeHtml(hash)}</small></p>`);
          return true;
        }
      }

      json(res, 404, { error: "bulunamadi" });
      return true;
    } catch (error) {
      const code = error.status ?? 400;
      if (url.pathname === "/verify/profile/approve") {
        html(res, code, "Hata", `<h1>Islem yapilamadi</h1><p>${escapeHtml(error.message)}</p>`);
      } else {
        json(res, code, { error: error.message });
      }
      return true;
    }
  };
}
