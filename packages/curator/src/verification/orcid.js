/**
 * ORCID ile giris ve kurum eslestirmesi.
 *
 * SAHIPLIK: ORCID'in OAuth akisi, donen ORCID iD'nin girisi yapan kisiye ait
 * oldugunu ORCID'in kendisi dogrular. Profil sayfasini okumak bunu yapamazdi.
 *
 * KURUM: Kayittaki guncel istihdamin kurumu, e-postanin alan adiyla
 * eslestirilir. Eslestirme ISIM TAHMINIYLE yapilmaz; kurumun ROR kaydindaki
 * resmi alan adina bakilir (ornek: Erciyes -> erciyes.edu.tr).
 *
 * KANIT GUCU: ORCID istihdam kaydini kimin girdigini soyler. Kisi kendisi
 * girdiyse beyandir; bir uye kurumun sistemi girdiyse kurum onaylidir.
 */

const ORCID_BASE = process.env.ORCID_BASE_URL ?? "https://orcid.org";
const ORCID_API = process.env.ORCID_API_URL ?? "https://pub.orcid.org";
const ROR_API = process.env.ROR_API_URL ?? "https://api.ror.org/v2";

export const EVIDENCE = { MANUAL: 1, ORCID_SELF: 2, ORCID_INSTITUTION: 3 };

export function authorizeUrl({ clientId, redirectUri, state }) {
  const url = new URL("/oauth/authorize", ORCID_BASE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "/authenticate");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

/** Yetki kodunu ORCID iD'ye cevirir. Gizli anahtar sunucudan cikmaz. */
export async function exchangeCode({ clientId, clientSecret, redirectUri, code }) {
  const res = await fetch(new URL("/oauth/token", ORCID_BASE), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`ORCID giris dogrulanamadi (${res.status})`);
  const body = await res.json();
  if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(body.orcid ?? "")) throw new Error("ORCID yaniti gecersiz");
  return { orcid: body.orcid, name: body.name ?? null };
}

/** Kaydin HERKESE ACIK istihdam girdilerini okur. */
export async function fetchEmployments(orcid) {
  const res = await fetch(`${ORCID_API}/v3.0/${orcid}/employments`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`ORCID kaydi okunamadi (${res.status})`);
  const body = await res.json();
  const out = [];
  for (const group of body["affiliation-group"] ?? []) {
    for (const summary of group.summaries ?? []) {
      const e = summary["employment-summary"];
      if (!e) continue;
      const dis = e.organization?.["disambiguated-organization"] ?? null;
      out.push({
        name: e.organization?.name ?? "",
        current: e["end-date"] == null,
        disambiguation: dis
          ? { source: dis["disambiguation-source"], id: dis["disambiguated-organization-identifier"] }
          : null,
        // Kurum sistemi girdiyse `source-client-id` dolu olur.
        institutionAsserted: Boolean(e.source?.["source-client-id"]),
      });
    }
  }
  return out;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Bir ROR kaydinin alan adlari: `domains` alani + resmi web adresinin sunucusu. */
export function rorDomains(record) {
  const set = new Set((record.domains ?? []).map((d) => String(d).toLowerCase()));
  for (const link of record.links ?? []) {
    if (link.type && link.type !== "website") continue;
    const host = hostOf(link.value);
    if (host) set.add(host);
  }
  return set;
}

/** Alan adi, kurumun alan adiyla ya da onun alt alan adiyla eslesiyor mu? */
export function domainMatches(domains, universityDomain) {
  for (const d of domains) {
    if (d === universityDomain || universityDomain.endsWith(`.${d}`) || d.endsWith(`.${universityDomain}`)) {
      return true;
    }
  }
  return false;
}

async function rorById(id) {
  const clean = String(id).replace(/^https?:\/\/ror\.org\//, "");
  const res = await fetch(`${ROR_API}/organizations/${encodeURIComponent(clean)}`);
  return res.ok ? res.json() : null;
}

/**
 * Dagınık bir kurum yazimini ROR kaydina cevirir.
 *
 * Duz isim aramasi YETMEDI: gercek bir Erciyes calisani kurumunu
 * "Erciyes Üniversitesi/ Erciyes University" diye girmisti ve isim aramasi hic
 * sonuc dondurmedi - haksiz bir ret. ROR'un affiliation eslestirmesi bu tur
 * yazimlar icin tasarlanmis (fakulte adlari dahil) ve yalnizca emin oldugu
 * eslesmeyi `chosen` olarak isaretliyor. Yalnizca o alinir.
 */
async function rorAffiliation(name) {
  const res = await fetch(`${ROR_API}/organizations?affiliation=${encodeURIComponent(name)}`);
  if (!res.ok) return [];
  return ((await res.json()).items ?? []).filter((item) => item.chosen).map((item) => item.organization);
}

/**
 * Guncel istihdamlardan, e-posta alan adiyla ayni kuruma ait olani bulur.
 *
 * Kurum ROR ile tanimlanmissa dogrudan o kayda bakilir. Baska bir kaynakla
 * (Ringgold, GRID, FundRef) tanimlanmissa ya da hic tanimlanmamissa ROR'un
 * affiliation eslestirmesine sorulur ve YALNIZCA emin oldugu eslesme alinir.
 * Her iki durumda da alan adi birebir tutmalidir - isim benzerligi tek basina
 * yetmez.
 *
 * @returns {{ matched: boolean, evidence?: number, organization?: string }}
 */
export async function matchAffiliation(employments, universityDomain, lookup = { rorById, rorAffiliation }) {
  const current = employments.filter((e) => e.current);
  // Kurum onayli kayitlar once denenir: ayni kurum icin daha guclu kanit.
  current.sort((a, b) => Number(b.institutionAsserted) - Number(a.institutionAsserted));

  for (const e of current) {
    let candidates = [];
    if (e.disambiguation?.source === "ROR") {
      const record = await lookup.rorById(e.disambiguation.id);
      if (record) candidates = [record];
    } else if (e.name) {
      candidates = await lookup.rorAffiliation(e.name);
    }
    for (const record of candidates) {
      if (domainMatches(rorDomains(record), universityDomain)) {
        return {
          matched: true,
          evidence: e.institutionAsserted ? EVIDENCE.ORCID_INSTITUTION : EVIDENCE.ORCID_SELF,
          organization: e.name,
        };
      }
    }
  }
  return { matched: false };
}
