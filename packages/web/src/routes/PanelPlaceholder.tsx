import type { SessionRole } from "../lib/session";

export function PanelPlaceholder({ role }: { role: Exclude<SessionRole, null> }) {
  const isOwner = role === "veri-sahibi";
  return (
    <section className="panel-placeholder">
      <span className="eyebrow">FAZ A</span>
      <h1>{isOwner ? "Veri sahibi genel bakisi" : "Arastirmaci genel bakisi"}</h1>
      <p>
        {isOwner
          ? "Katki, kazanc, gizlilik ve dogrulama sekmeleri bir sonraki asamada burada yer alacak."
          : "Kayit, veri alma, sorgular, sonuclar ve dugum sekmeleri bir sonraki asamada burada yer alacak."}
      </p>
    </section>
  );
}
