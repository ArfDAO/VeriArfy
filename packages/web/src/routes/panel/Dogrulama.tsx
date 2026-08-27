import { TraceConsole } from "../../components/TraceConsole";
import { useTrace } from "../../lib/useTrace";

export function Dogrulama() {
  const trace = useTrace();
  return <section className="privacy"><div><span className="eyebrow">VERI SAHIBI / DOGRULAMA</span><h1>Islem kanitlari</h1><p className="card__body">Veri yukleme akisinin islem ozetleri, bloklari, gaz kullanimi ve zincirden geri okunan kanitlari burada kalir.</p></div><TraceConsole steps={trace.steps} /></section>;
}
