/**
 * Uretim kodunun kendisini calistiran kanit harness'i.
 *
 * Mock yok: gercek `useVcfParser` ve `useFheEncryptor` hook'lari, gercek
 * worker'lar ve gercek wasm paketleri uzerinden tam zincir kosuyor:
 *
 *   VCF dosyasi -> dozaj vektoru -> panel filtresi -> FHE blob -> cozum
 *
 * Uygulamanin parcasi degildir; `npm run dev` ile /dev/fhe-harness.html
 * adresinden acilir.
 */

import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { useVcfParser } from "../src/lib/useVcfParser";
import { useFheEncryptor } from "../src/lib/useFheEncryptor";

interface Case {
  name: string;
  ok: boolean;
  detail: string;
}

/** Faz 1'in ayristiracagi gercek bir VCF metni. Dozaj deseni bilinir. */
function makeVcf(n: number) {
  const gts = ["0/0:30", "0/1:31", "1|1:19", "./.:0", "1/2:44"];
  let out =
    "##fileformat=VCFv4.3\n" +
    "##contig=<ID=chr1,length=248956422>\n" +
    '##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">\n' +
    '##FORMAT=<ID=DP,Number=1,Type=Integer,Description="Read Depth">\n' +
    "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tNA12878\n";
  for (let i = 1; i <= n; i++) {
    out += `chr1\t${i}\trs${i}\tA\tG,T\t50\tPASS\t.\tGT:DP\t${gts[i % 5]}\n`;
  }
  return out;
}

const VARIANTS = 2000;
/** Calismanin ilgilendigi SNP'ler — bilincli olarak sirasiz. */
const PANEL = [1500, 3, 977, 42, 8, 1999, 256, 1000, 77, 512];

const eq = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;

function Harness() {
  const vcf = useVcfParser();
  const fhe = useFheEncryptor();

  const [cases, setCases] = useState<Case[]>([]);
  const [stats, setStats] = useState<[string, string][]>([]);
  const [phase, setPhase] = useState("baslatiliyor…");
  const [done, setDone] = useState(false);
  const started = useRef(false);
  /** FHE zinciri tek sefer kosmali: `fhe` durumu degistikce effect yeniden tetiklenir. */
  const chainStarted = useRef(false);

  const add = (name: string, ok: boolean, detail = "") =>
    setCases((prev) => [...prev, { name, ok, detail }]);

  // 1) VCF'i ayristir.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    setPhase("Faz 1: VCF ayristiriliyor…");
    vcf.parse(new Blob([makeVcf(VARIANTS)]));
  }, [vcf]);

  // 2) Dozajlar gelince FHE zincirini kosur.
  useEffect(() => {
    if (!vcf.result || chainStarted.current) return;
    chainStarted.current = true;
    const dosages = vcf.result.dosages;

    (async () => {
      try {
        add(
          `Faz 1: ${VARIANTS} varyant ayristirildi`,
          vcf.result!.variantCount === VARIANTS,
          `ilk 10: [${dosages.slice(0, 10)}]`,
        );

        // --- Panel onizlemesi: anahtar gerekmeden, aninda ---
        setPhase("panel onizlemesi…");
        const preview = await fhe.previewPanel(dosages, PANEL);
        const expected = PANEL.map((i) => dosages[i]);
        add(
          "panel onizlemesi anahtarsiz calisti ve dogru dozajlari sundu",
          eq(preview, expected),
          `${preview.length} varyant: [${preview}]`,
        );

        // --- Panel dogrulamasi: hatali indeks sessizce gecmemeli ---
        let rejectedRange = "";
        try {
          await fhe.previewPanel(dosages, [0, VARIANTS + 5]);
        } catch (e) {
          rejectedRange = (e as Error).message;
        }
        add("sinir disi indeks reddedildi", rejectedRange.length > 0, rejectedRange.slice(0, 60));

        let rejectedDup = "";
        try {
          await fhe.previewPanel(dosages, [7, 7]);
        } catch (e) {
          rejectedDup = (e as Error).message;
        }
        add("tekrarlanan indeks reddedildi", rejectedDup.length > 0, rejectedDup.slice(0, 60));

        // --- Anahtar uretimi (worker'da; arayuz donmamali) ---
        // Bu modulun tum varlik sebebi: 4 saniyelik keygen main thread'i
        // kilitlemesin. Iddiayi varsaymak yerine olcuyoruz.
        //
        // Olcum araci olarak `requestAnimationFrame` KULLANILMAZ: sekme arka
        // plandayken tarayici rAF'i tamamen durdurur ve donmamis bir thread
        // bile "0 kare" gorunur. `setTimeout` da arka planda ~1 sn'ye
        // kisitlanir. MessageChannel ping-pong'u ise gorunurlukten etkilenmez
        // ve dogrudan gorev kuyrugunun aktif olup olmadigini olcer.
        setPhase("anahtar uretiliyor (worker'da)…");
        let ticks = 0;
        let maxGapMs = 0;
        let last = performance.now();
        let watching = true;

        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          if (!watching) return;
          const now = performance.now();
          maxGapMs = Math.max(maxGapMs, now - last);
          last = now;
          ticks++;
          channel.port2.postMessage(0);
        };
        channel.port2.postMessage(0);

        const key = await fhe.generateKey();
        watching = false;
        channel.port1.close();
        channel.port2.close();

        // NOT: bu olcum kendisi bir sicak dongudur ve CPU'yu worker ile
        // paylasir; bu yuzden burada raporlanan keygen suresi gercek maliyetten
        // (olcum kapaliyken ~4 sn) belirgin sekilde yuksek cikar. Onemli olan
        // sayi keygen suresi degil, **en uzun kesinti**: 14 ms mertebesindeki
        // bir deger arayuzun hic donmadigini gosterir.
        add(
          "anahtar uretilirken ana thread CANLI kaldi",
          maxGapMs < 300 && ticks > 100,
          `${ticks.toLocaleString("tr-TR")} gorev islendi · en uzun kesinti ${maxGapMs.toFixed(0)} ms`,
        );
        add(
          "anahtar worker icinde uretildi ve sifreli metin boyutu olculdu",
          key.ciphertextBytes > 0,
          `${key.elapsedMs.toFixed(0)} ms · ${kb(key.ciphertextBytes)}/dozaj`,
        );

        // --- Panel sifrelemesi ---
        setPhase("panel sifreleniyor…");
        const enc = await fhe.encrypt(dosages, { panel: PANEL });
        add(
          `${PANEL.length} varyantlik panel sifrelendi (tamami degil)`,
          enc.count === PANEL.length,
          `${kb(enc.sizeBytes)} · ${enc.elapsedMs.toFixed(0)} ms`,
        );

        // --- Blob kendi panelini tasiyor mu? ---
        const info = await fhe.inspect(enc.blob);
        add(
          "blob, panel indekslerini cozmeden okunabilir sekilde tasiyor",
          !!info.panel && eq(info.panel, PANEL),
          `panel: [${info.panel?.slice(0, 5)}…]`,
        );

        // --- ASIL KANIT: cozum panelin dozajlarini birebir veriyor mu? ---
        setPhase("cozuluyor…");
        const back = await fhe.decrypt(enc.blob);
        add("cozum, panelin dozajlarini BIREBIR geri verdi", eq(back, expected), `[${back}]`);

        // --- Tam vektor ne kadar tutardi? ---
        const fullEstimate = key.ciphertextBytes * dosages.length;
        setStats([
          ["ayristirilan varyant", `${VARIANTS}`],
          ["panel", `${PANEL.length} varyant`],
          // Olcum dongusu CPU'yu paylastigi icin bu sure sisiktir; olcum
          // kapaliyken gercek deger ~4 sn.
          ["anahtar uretimi (olcum yuku altinda)", `${key.elapsedMs.toFixed(0)} ms`],
          ["keygen sirasinda en uzun donma", `${maxGapMs.toFixed(0)} ms`],
          ["panel sifreleme", `${enc.elapsedMs.toFixed(0)} ms`],
          ["panel blob", kb(enc.sizeBytes)],
          ["tek sifreli dozaj", kb(key.ciphertextBytes)],
          [
            "tum vektor sifrelenseydi",
            fullEstimate ? `~${(fullEstimate / 1048576).toFixed(1)} MB` : "—",
          ],
          [
            "panelin kazandirdigi",
            fullEstimate ? `${(fullEstimate / enc.sizeBytes).toFixed(0)}x kucuk` : "—",
          ],
        ]);

        setPhase("bitti");
        setDone(true);
      } catch (e) {
        add("BEKLENMEDIK HATA", false, (e as Error).message);
        setPhase("hata");
        setDone(true);
      }
    })();
  }, [vcf.result, fhe]);

  const pass = cases.filter((c) => c.ok).length;
  const fail = cases.length - pass;

  return (
    <>
      <h1>VeriArfy · hook zinciri</h1>
      <p className="sub">
        Gerçek <code>useVcfParser</code> + <code>useFheEncryptor</code> hook'ları,
        gerçek worker'lar, gerçek wasm. Durum: {phase}
      </p>

      <section>
        <h2>DOGRULAMALAR</h2>
        {cases.map((c, i) => (
          <div className="case" key={i}>
            <span className={`badge ${c.ok ? "ok" : "fail"}`}>{c.ok ? "GECTI" : "KALDI"}</span>
            <span className="name">{c.name}</span>
            <span className="val">{c.detail}</span>
          </div>
        ))}
      </section>

      {stats.length > 0 && (
        <section>
          <h2>OLCUMLER</h2>
          <table>
            <tbody>
              {stats.map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {(vcf.error || fhe.error) && (
        <section>
          <h2>HATA</h2>
          <div className="val">{vcf.error ?? fhe.error}</div>
        </section>
      )}

      {done && (
        <div
          id="verdict"
          style={{
            background: fail === 0 ? "#16301f" : "#3a1a16",
            color: fail === 0 ? "#57c99a" : "#e8654f",
          }}
        >
          {fail === 0
            ? `TUM DOGRULAMALAR GECTI — ${pass}/${cases.length}`
            : `${fail} DOGRULAMA BASARISIZ — ${pass}/${cases.length}`}
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
