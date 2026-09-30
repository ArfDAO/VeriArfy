/**
 * E-posta gonderimi.
 *
 * SMTP KULLANILMIYOR: barindirildigi ucretsiz ortam giden SMTP portlarini
 * (25, 465, 587) engelliyor. Gonderim HTTPS uzerinden bir e-posta API'siyle
 * yapiliyor (Resend).
 *
 * Yapilandirilmamissa SAHTE GONDERIM YAPILMAZ; acik bir hata doner. Kodu
 * konsola yazmak gibi bir kisayol, dogrulamayi dogrulama olmaktan cikarirdi.
 */
export function mailerConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

export async function sendMail({ to, subject, text }) {
  if (!mailerConfigured()) {
    const error = new Error("e-posta gonderimi yapilandirilmadi (RESEND_API_KEY, MAIL_FROM)");
    error.status = 503;
    throw error;
  }
  const res = await fetch(process.env.MAIL_API_URL ?? "https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const error = new Error(`e-posta gonderilemedi (${res.status}) ${body.slice(0, 200)}`);
    error.status = 502;
    throw error;
  }
}
