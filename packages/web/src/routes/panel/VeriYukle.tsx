import { Contribute } from "../../components/Contribute";
import { useT } from "../../lib/i18n";

export function VeriYukle() {
  const t = useT();
  return (
    <section className="data-upload" aria-labelledby="data-upload-title">
      <div className="data-upload__heading">
        <span className="eyebrow">{t("VERI SAHIBI / VERI YUKLEME")}</span>
        <h1 id="data-upload-title">{t("Verinizi cihazinizda sifreleyin")}</h1>
        <p>{t("Ham dosyaniz tarayicidan cikmaz. Zincire yalnizca sifreli degerler ve dogrulama kanitlari gider.")}</p>
      </div>
      <Contribute />
    </section>
  );
}
