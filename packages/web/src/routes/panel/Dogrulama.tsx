import { TraceConsole } from "../../components/TraceConsole";
import { useT } from "../../lib/i18n";
import { useTrace } from "../../lib/useTrace";

export function Dogrulama() {
  const t = useT();
  const trace = useTrace();
  return <section className="privacy"><div><span className="eyebrow">{t("VERI SAHIBI / DOGRULAMA")}</span><h1>{t("Islem kanitlari")}</h1><p className="card__body">{t("Veri yukleme akisinin islem ozetleri, bloklari, gaz kullanimi ve zincirden geri okunan kanitlari burada kalir.")}</p></div><TraceConsole steps={trace.steps} /></section>;
}
