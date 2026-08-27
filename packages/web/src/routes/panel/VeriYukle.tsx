import { Contribute } from "../../components/Contribute";

export function VeriYukle() {
  return (
    <section className="data-upload" aria-labelledby="data-upload-title">
      <div className="data-upload__heading">
        <span className="eyebrow">VERI SAHIBI / VERI YUKLEME</span>
        <h1 id="data-upload-title">Verinizi cihazinizda sifreleyin</h1>
        <p>Ham dosyaniz tarayicidan cikmaz. Zincire yalnizca sifreli degerler ve dogrulama kanitlari gider.</p>
      </div>
      <Contribute />
    </section>
  );
}
