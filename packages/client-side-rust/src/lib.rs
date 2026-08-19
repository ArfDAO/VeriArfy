//! # VeriArfy — Client-Side VCF Stream Parser
//!
//! Bu modul, kullanicinin ham genom dosyasinin (VCF) **tarayiciyi hic terk etmeden**
//! FHE (Tam Homomorfik Sifreleme) icin hazir bir dozaj vektorune cevrilmesini saglar.
//!
//! ## Tasarim ilkeleri
//!
//! 1. **Sifir tam-dosya kopyasi.** Dosya hicbir zaman tek bir `String`/`Vec<u8>` icine
//!    alinmaz. JS tarafindan gelen her chunk islenir, tamamlanmis satirlar ayristirilir,
//!    yarim kalan son satir kucuk bir tamponda (`line_buf`) bir sonraki chunk'a devredilir.
//!    Boylece 5 GB'lik bir VCF icin de tepe bellek kullanimi
//!    `chunk boyutu + en uzun satir + dozaj vektoru` kadardir.
//! 2. **Tek `Record` yeniden kullanimi.** `noodles` `Record` nesnesi her satirda yeniden
//!    tahsis edilmez; ic tamponu `clear()` edilerek tekrar doldurulur (allocation-free hot loop).
//! 3. **Gercek VCF semantigi.** Satirlar elle `split(',')` ile parcalanmaz; header
//!    `noodles_vcf::Header` ile, satirlar `noodles_vcf::io::Reader` ile, GT alani ise
//!    `variant::record::samples::series::value::Genotype` trait'i ile cozulur.
//!    Bu sayede fazli (phased `|`), haploid, cok-alelli ve eksik (`./.`) genotipler
//!    standarda uygun ele alinir.
//!
//! ## Dozaj eslemesi (Ismail'in kurallari)
//!
//! | GT           | Anlam                  | Cikti |
//! |--------------|------------------------|-------|
//! | `0/0`, `0|0` | Referans ile ayni      | `0`   |
//! | `0/1`, `1/0` | Heterozigot mutasyon   | `1`   |
//! | `1/1`        | Homozigot mutasyon     | `2`   |
//!
//! Genellestirme: **referans olmayan (alt) alel sayisi** sayilir, `2` ile sinirlanir.
//! Bu sayede `1/2` (cok-alelli homozigot-olmayan) -> `2`, haploid `1` (chrX/chrY) -> `1`
//! olarak dogru sekilde kodlanir. Eksik genotipler (`./.`) `0` yazilir ve
//! `missing_genotype_count` sayaciyla ayrica raporlanir — boylece cikti dizisi
//! her zaman referans varyant listesiyle **pozisyonel olarak hizali** kalir.

use std::fmt::{self, Display};

use js_sys::{Function, Reflect, Uint8Array};
use std::collections::HashSet;

/// Eksik / cagirilamamis genotip isareti.
///
/// `VeriarfyProtocol.DOSAGE_MISSING` ile AYNI olmak zorundadir: sozlesme
/// aralik disi degeri buna kirpar ve 3, kontenjans tablosunun sordugu
/// `dozaj == 0|1|2` sorularinin hicbirine uymaz.
pub const DOSAGE_MISSING: u8 = 3;

use noodles_vcf::variant::record::Ids as _;
use noodles_vcf::{
    self as vcf, Header, Record,
    variant::record::samples::series::{Value, value::genotype::Genotype},
};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::{Blob, ReadableStream, ReadableStreamDefaultReader};

// --------------------------------------------------------------------------------------
// Yardimcilar
// --------------------------------------------------------------------------------------

/// Ayristirma hatasi.
///
/// Ic mantik bilincli olarak `JsValue` degil bu tipi kullanir: `JsValue` yalnizca
/// wasm hedefinde olusturulabilir, dolayisiyla hata yollari ancak boyle native
/// `cargo test` ile de test edilebilir. Cevirim tek noktada, API sinirinda yapilir.
#[derive(Debug)]
pub struct ParseError(String);

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<ParseError> for JsValue {
    fn from(e: ParseError) -> Self {
        JsError::new(&e.0).into()
    }
}

fn err(msg: impl Display) -> ParseError {
    ParseError(msg.to_string())
}

// --------------------------------------------------------------------------------------
// Sonuc tipi
// --------------------------------------------------------------------------------------

/// Ayristirma sonucu: FHE'ye verilecek dozaj vektoru + kalite metrikleri.
#[wasm_bindgen]
pub struct VcfParseResult {
    dosages: Vec<u8>,
    /// Dozajlarla AYNI SIRADA varyant kimlikleri (rsID).
    ///
    /// Panel filtresi verilmediyse bos kalir: milyonlarca kimligi bellekte
    /// tutmak tarayiciyi sisirirdi ve filtresiz modda kimseye lazim degildir.
    ids: Vec<String>,
    sample_name: String,
    sample_names: Vec<String>,
    variant_count: u32,
    missing_genotype_count: u32,
    skipped_line_count: u32,
    /// Panelde bulunmadigi icin atlanan varyant sayisi (filtreli modda).
    filtered_out_count: u32,
    bytes_processed: f64,
}

#[wasm_bindgen]
impl VcfParseResult {
    /// FHE'ye girecek dozaj vektoru (`0 | 1 | 2`), `Uint8Array` olarak.
    ///
    /// Not: Wasm lineer bellegine dogrudan *view* dondurmek yerine bilincli olarak
    /// **kopya** doneriz. View, wasm heap'i buyudugunde (memory.grow) sessizce
    /// gecersizlesir ve tibbi veride sessiz bozulma kabul edilemez.
    #[wasm_bindgen(getter)]
    pub fn dosages(&self) -> Uint8Array {
        Uint8Array::from(&self.dosages[..])
    }

    /// Dozajlarla ayni siradaki varyant kimlikleri.
    ///
    /// PANELE HIZALAMANIN SART KOSULU. Zincir yalnizca sirali dozajlar gorur;
    /// hangi varyanta ait olduklari yazili degildir. Kimlikler cikmadan iki
    /// kullanicinin "3 numarali SNP"si farkli varyantlar olur ve kontenjans
    /// tablosu alakasiz seyleri toplar — tek kullaniciyla fark edilmeyen,
    /// ikinci kullanicida sessizce bozulan bir hata.
    #[wasm_bindgen(getter)]
    pub fn ids(&self) -> Vec<String> {
        self.ids.clone()
    }

    /// Dozaji hesaplanan ornek (sample) adi.
    #[wasm_bindgen(getter, js_name = sampleName)]
    pub fn sample_name(&self) -> String {
        self.sample_name.clone()
    }

    /// VCF header'inda tanimli tum ornek adlari.
    #[wasm_bindgen(getter, js_name = sampleNames)]
    pub fn sample_names(&self) -> Vec<String> {
        self.sample_names.clone()
    }

    /// Islenen gecerli varyant sayisi (== `dosages.length`).
    #[wasm_bindgen(getter, js_name = variantCount)]
    pub fn variant_count(&self) -> u32 {
        self.variant_count
    }

    /// GT'si eksik (`./.`) oldugu icin `0` yazilan varyant sayisi.
    #[wasm_bindgen(getter, js_name = missingGenotypeCount)]
    pub fn missing_genotype_count(&self) -> u32 {
        self.missing_genotype_count
    }

    /// GT alani hic bulunmadigi icin atlanan satir sayisi.
    #[wasm_bindgen(getter, js_name = skippedLineCount)]
    pub fn skipped_line_count(&self) -> u32 {
        self.skipped_line_count
    }

    /// Panelde bulunmadigi icin atlanan varyant sayisi.
    ///
    /// Kapsama oranini gostermek icin: "dosyada 601.885 varyant vardi,
    /// panelin 998'i bulundu, 2'si dosyada yok."
    #[wasm_bindgen(getter, js_name = filteredOutCount)]
    pub fn filtered_out_count(&self) -> u32 {
        self.filtered_out_count
    }

    /// Okunan toplam bayt (ilerleme dogrulamasi icin).
    #[wasm_bindgen(getter, js_name = bytesProcessed)]
    pub fn bytes_processed(&self) -> f64 {
        self.bytes_processed
    }
}

// --------------------------------------------------------------------------------------
// Stream parser
// --------------------------------------------------------------------------------------

/// Chunk-chunk beslenen, durum tutan VCF ayristirici.
///
/// Kullanim: `new` -> `pushChunk(...)` (N kez) -> `finish()`.
#[wasm_bindgen]
pub struct VcfStreamParser {
    /// `##` meta satirlari + `#CHROM` satiri; sadece header cozulene kadar dolar,
    /// sonra bosaltilir (5 GB'lik dosyada bile header birkac yuz KB'dir).
    header_src: String,
    /// Cozulmus header. `None` ise henuz `#CHROM` satirina gelinmedi.
    header: Option<Header>,
    /// Chunk sinirinda yarim kalan satirin tamponu.
    line_buf: Vec<u8>,
    /// Her satirda yeniden kullanilan record (tahsis yapmayan sicak dongü).
    record: Record,
    /// Cikti dozaj vektoru.
    dosages: Vec<u8>,
    /// Filtreli modda dozajlarla ayni siradaki varyant kimlikleri.
    ids: Vec<String>,
    /// Panelin rsID kumesi. `None` ise TUM varyantlar dosya sirasiyla alinir.
    ///
    /// Filtreleme burada yapilir cunku tum genom VCF'i milyonlarca satirdir;
    /// hepsini alip sonra JS tarafinda elemek, isin buyuk kismini bellege
    /// tasimak olurdu.
    wanted: Option<HashSet<String>>,
    /// Panelde OLMADIGI icin atlanan varyant sayisi.
    filtered_out_count: u32,
    /// Hedef ornegin kolon indeksi.
    sample_index: usize,
    /// Kullanicinin istedigi ornek adi (yoksa ilk ornek kullanilir).
    requested_sample: Option<String>,
    resolved_sample_name: String,
    sample_names: Vec<String>,

    variant_count: u32,
    missing_genotype_count: u32,
    skipped_line_count: u32,
    bytes_processed: f64,
    finished: bool,
}

#[wasm_bindgen]
impl VcfStreamParser {
    /// Yeni bir ayristirici olusturur.
    ///
    /// * `sample_name` — cok ornekli (multi-sample) VCF'te hangi ornegin dozajinin
    ///   cikarilacagi. `null`/`undefined` ise ilk ornek kolonu kullanilir.
    #[wasm_bindgen(constructor)]
    pub fn new(sample_name: Option<String>) -> Self {
        Self {
            header_src: String::new(),
            header: None,
            line_buf: Vec::with_capacity(4096),
            record: Record::default(),
            dosages: Vec::new(),
            ids: Vec::new(),
            wanted: None,
            filtered_out_count: 0,
            sample_index: 0,
            requested_sample: sample_name.filter(|s| !s.is_empty()),
            resolved_sample_name: String::new(),
            sample_names: Vec::new(),
            variant_count: 0,
            missing_genotype_count: 0,
            skipped_line_count: 0,
            bytes_processed: 0.0,
            finished: false,
        }
    }

    /// Calismanin panelini verir: YALNIZCA bu kimlikler toplanir.
    ///
    /// Verildiginde sonuc `ids` alani dolar ve dozajlar panele hizalanabilir
    /// hale gelir. Verilmezse eski davranis surer (tum varyantlar, dosya
    /// sirasiyla, kimliksiz).
    #[wasm_bindgen(js_name = setWantedIds)]
    pub fn set_wanted_ids(&mut self, ids: Vec<String>) {
        if ids.is_empty() {
            self.wanted = None;
            return;
        }
        self.wanted = Some(ids.into_iter().collect());
    }

    /// Panelde bulunmadigi icin atlanan varyant sayisi.
    #[wasm_bindgen(getter, js_name = filteredOutCount)]
    pub fn filtered_out_count(&self) -> u32 {
        self.filtered_out_count
    }

    /// Beklenen varyant sayisi biliniyorsa cagirin: dozaj vektoru tek seferde tahsis
    /// edilir, milyonlarca `push` sirasinda tekrar tekrar realloc yapilmaz.
    #[wasm_bindgen(js_name = reserve)]
    pub fn reserve(&mut self, expected_variants: usize) {
        self.dosages.reserve(expected_variants);
    }

    /// JS'ten gelen bir bayt blogunu isler.
    ///
    /// Chunk'in satir siniri uzerine denk gelmesi **gerekmez**; yarim satir
    /// dahili tamponda saklanip bir sonraki cagriya devredilir.
    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, chunk: &[u8]) -> Result<(), JsValue> {
        self.push_chunk_inner(chunk).map_err(JsValue::from)
    }

    /// Akisi kapatir, tamponda kalan son satiri isler ve sonucu dondurur.
    #[wasm_bindgen(js_name = finish)]
    pub fn finish(&mut self) -> Result<VcfParseResult, JsValue> {
        self.finish_inner().map_err(JsValue::from)
    }

    /// Ilerleme gostergesi icin: su ana kadar uretilen dozaj sayisi.
    #[wasm_bindgen(getter, js_name = variantCount)]
    pub fn variant_count(&self) -> u32 {
        self.variant_count
    }

    /// Ilerleme gostergesi icin: su ana kadar okunan bayt.
    #[wasm_bindgen(getter, js_name = bytesProcessed)]
    pub fn bytes_processed(&self) -> f64 {
        self.bytes_processed
    }
}

// -- wasm_bindgen'e acilmayan ic mantik ---------------------------------------------------

impl VcfStreamParser {
    fn push_chunk_inner(&mut self, chunk: &[u8]) -> Result<(), ParseError> {
        if self.finished {
            return Err(err("parser zaten finish() ile kapatildi"));
        }

        self.bytes_processed += chunk.len() as f64;

        let mut rest = chunk;
        while let Some(nl) = memchr_newline(rest) {
            let (line, tail) = rest.split_at(nl);
            rest = &tail[1..]; // '\n' atlanir

            if self.line_buf.is_empty() {
                // Sik yol: satir tamamen bu chunk icinde — kopyalamadan isle.
                self.consume_line(line)?;
            } else {
                // Onceki chunk'tan devreden parcayla birlestir.
                self.line_buf.extend_from_slice(line);
                let buf = std::mem::take(&mut self.line_buf);
                self.consume_line(&buf)?;
                self.line_buf = buf;
                self.line_buf.clear();
            }
        }

        // Kalan yarim satiri sakla.
        if !rest.is_empty() {
            self.line_buf.extend_from_slice(rest);
        }

        Ok(())
    }

    fn finish_inner(&mut self) -> Result<VcfParseResult, ParseError> {
        if !self.line_buf.is_empty() {
            let buf = std::mem::take(&mut self.line_buf);
            self.consume_line(&buf)?;
        }
        self.finished = true;

        if self.header.is_none() {
            return Err(err(
                "gecerli bir VCF header'i bulunamadi (##fileformat / #CHROM satiri yok)",
            ));
        }

        Ok(VcfParseResult {
            dosages: std::mem::take(&mut self.dosages),
            ids: std::mem::take(&mut self.ids),
            sample_name: self.resolved_sample_name.clone(),
            sample_names: self.sample_names.clone(),
            variant_count: self.variant_count,
            missing_genotype_count: self.missing_genotype_count,
            skipped_line_count: self.skipped_line_count,
            filtered_out_count: self.filtered_out_count,
            bytes_processed: self.bytes_processed,
        })
    }

    /// Tek bir (satir sonu icermeyen) VCF satirini isler.
    fn consume_line(&mut self, line: &[u8]) -> Result<(), ParseError> {
        // Windows satir sonlarina (CRLF) tolerans.
        let line = match line.last() {
            Some(b'\r') => &line[..line.len() - 1],
            _ => line,
        };

        if line.is_empty() {
            return Ok(());
        }

        if line[0] == b'#' {
            if self.header.is_some() {
                // Header cozuldukten sonra gelen '#' satiri gecersizdir; sessizce atla.
                self.skipped_line_count += 1;
                return Ok(());
            }
            let text = std::str::from_utf8(line)
                .map_err(|e| err(format!("header satiri UTF-8 degil: {e}")))?;
            self.header_src.push_str(text);
            self.header_src.push('\n');

            // '#CHROM ...' kolon basligi header'in son satiridir.
            if !line.starts_with(b"##") {
                self.finalize_header()?;
            }
            return Ok(());
        }

        // Header gelmeden veri satiri => bozuk dosya.
        let header = self
            .header
            .as_ref()
            .ok_or_else(|| err("VCF header'i okunmadan veri satiri geldi (bozuk dosya)"))?;

        // Satiri `noodles` ile ayristir. `Reader` burada sadece bir `&[u8]` uzerinde
        // calisir; dosyanin tamami degil, yalnizca bu satir bellektedir.
        let mut reader = vcf::io::Reader::new(line);
        reader
            .read_record(&mut self.record)
            .map_err(|e| err(format!("varyant satiri ayristirilamadi: {e}")))?;

        // PANEL FILTRESI — varsa, once kimlige bakilir.
        //
        // Kimlik cikarmak ucuz degil (ID alani dolasilir), ama alternatifi tum
        // genomu bellege almak. Filtre yoksa bu blok hic calismaz.
        let matched_id = match &self.wanted {
            None => None,
            Some(wanted) => {
                let mut found: Option<String> = None;
                for id in self.record.ids().iter() {
                    if wanted.contains(id) {
                        found = Some(id.to_string());
                        break;
                    }
                }
                match found {
                    Some(id) => Some(id),
                    None => {
                        self.filtered_out_count += 1;
                        return Ok(());
                    }
                }
            }
        };

        match genotype_dosage(header, &self.record, self.sample_index)? {
            Some(Dosage::Called(d)) => {
                self.dosages.push(d);
                if let Some(id) = matched_id {
                    self.ids.push(id);
                }
                self.variant_count += 1;
            }
            Some(Dosage::Missing) => {
                // EKSIK ICIN 0 YAZMAK SESSIZ BIR YALANDIR.
                //
                // 0, "homozigot referans" demektir — yani "bu mutasyonu
                // tasimiyor". Cagirilamamis bir genotipin dogru ifadesi
                // "bilmiyoruz"dur. 0 yazmak alel frekanslarini sistematik
                // olarak asagi ceker ve GWAS sonuclarini bozar.
                //
                // `DOSAGE_MISSING` sozlesmedeki degerle AYNIDIR: tablo
                // `dozaj == 0|1|2` sorularini sorar, 3 hicbirine uymaz ve
                // katilimci o varyantin tablosuna hic girmez.
                self.dosages.push(DOSAGE_MISSING);
                if let Some(id) = matched_id {
                    self.ids.push(id);
                }
                self.variant_count += 1;
                self.missing_genotype_count += 1;
            }
            None => {
                // FORMAT alaninda GT yok (or. sadece-site VCF satiri) -> atla.
                self.skipped_line_count += 1;
            }
        }

        Ok(())
    }

    /// `#CHROM` satirina ulasildiginda header'i cozer ve hedef ornek kolonunu bulur.
    fn finalize_header(&mut self) -> Result<(), ParseError> {
        let header = vcf::io::Reader::new(self.header_src.as_bytes())
            .read_header()
            .map_err(|e| err(format!("VCF header'i gecersiz: {e}")))?;

        self.sample_names = header.sample_names().iter().cloned().collect();

        if self.sample_names.is_empty() {
            return Err(err(
                "VCF'te ornek (sample) kolonu yok; genotip cikarilamaz (sites-only dosya)",
            ));
        }

        self.sample_index = match &self.requested_sample {
            Some(name) => header
                .sample_names()
                .get_index_of(name.as_str())
                .ok_or_else(|| err(format!("'{name}' adli ornek bu VCF'te bulunamadi")))?,
            None => 0,
        };
        self.resolved_sample_name = self.sample_names[self.sample_index].clone();

        self.header = Some(header);
        // Header metnine artik ihtiyac yok; bellegi geri ver.
        self.header_src = String::new();
        self.header_src.shrink_to_fit();

        Ok(())
    }
}

// --------------------------------------------------------------------------------------
// Genotip -> dozaj
// --------------------------------------------------------------------------------------

enum Dosage {
    Called(u8),
    Missing,
}

/// Bir record'un ilgili ornegindeki `GT` alanini `0 | 1 | 2` dozajina cevirir.
///
/// `Ok(None)` => bu satirda GT alani yok (atlanmali).
fn genotype_dosage<'a>(
    header: &'a Header,
    record: &'a Record,
    sample_index: usize,
) -> Result<Option<Dosage>, ParseError> {
    let samples = record.samples();

    // FORMAT kolonundaki anahtarlar arasinda GT'nin kacinci sirada oldugunu bul.
    // Spesifikasyon GT'yi ilk anahtar olmaya zorlar ama gercek dunyadaki
    // dosyalara guvenmek yerine acikca arariz.
    let Some(gt_index) = samples.keys().iter().position(|key| key == "GT") else {
        return Ok(None);
    };

    let Some(sample) = samples.get_index(sample_index) else {
        return Ok(None);
    };

    let value = match sample.get_index(header, gt_index) {
        Some(Some(result)) => result.map_err(|e| err(format!("GT alani okunamadi: {e}")))?,
        // Alan bos ya da '.' => cagrilamamis genotip.
        _ => return Ok(Some(Dosage::Missing)),
    };

    let genotype: Box<dyn Genotype + 'a> = match value {
        Value::Genotype(genotype) => genotype,
        other => {
            return Err(err(format!(
                "GT alani genotip olarak cozulemedi (beklenmeyen tip: {other:?})"
            )));
        }
    };

    let mut alt_alleles: u8 = 0;
    let mut any_allele = false;
    let mut missing = false;

    for result in genotype.iter() {
        let (position, _phasing) =
            result.map_err(|e| err(format!("genotip aleli ayristirilamadi: {e}")))?;
        any_allele = true;

        match position {
            // 0 => referans alel, katki yok.
            Some(0) => {}
            // >0 => alternatif alel (cok-alelli '1/2' dahil).
            Some(_) => alt_alleles = alt_alleles.saturating_add(1),
            // '.' => cagrilamamis alel.
            None => missing = true,
        }
    }

    if !any_allele || missing {
        return Ok(Some(Dosage::Missing));
    }

    // FHE devresi 0/1/2 bekliyor: poliploid uc durumlari sinirla.
    Ok(Some(Dosage::Called(alt_alleles.min(2))))
}

/// `\n` arayan kucuk yardimci (ek bagimlilik getirmemek icin elle yazildi).
#[inline]
fn memchr_newline(haystack: &[u8]) -> Option<usize> {
    haystack.iter().position(|&b| b == b'\n')
}

// --------------------------------------------------------------------------------------
// Asenkron yol: dogrudan File/Blob/ReadableStream
// --------------------------------------------------------------------------------------

/// Bir `ReadableStream`'i (or. `file.stream()`) bastan sona okuyup ayristirir.
///
/// Chunk'lar Rust icinde tuketilir; JS main thread'inde buyuk ara diziler olusmaz.
/// `on_progress` verilirse her chunk'ta `(bytesProcessed, totalBytes|null, variantCount)`
/// ile cagrilir — UI ilerleme cubugu icin.
#[wasm_bindgen(js_name = parseReadableStream)]
pub async fn parse_readable_stream(
    stream: ReadableStream,
    sample_name: Option<String>,
    total_bytes: Option<f64>,
    on_progress: Option<Function>,
) -> Result<VcfParseResult, JsValue> {
    let mut parser = VcfStreamParser::new(sample_name);

    let reader: ReadableStreamDefaultReader = stream.get_reader().unchecked_into();

    let read_result = async {
        loop {
            let result = JsFuture::from(reader.read()).await?;

            let done = Reflect::get(&result, &JsValue::from_str("done"))?
                .as_bool()
                .unwrap_or(false);
            if done {
                break;
            }

            let value = Reflect::get(&result, &JsValue::from_str("value"))?;
            let chunk = Uint8Array::from(value);

            // Chunk'i wasm bellegine kopyala; kapsam disina cikinca hemen serbest kalir.
            let mut bytes = vec![0u8; chunk.length() as usize];
            chunk.copy_to(&mut bytes);
            parser.push_chunk(&bytes)?;
            drop(bytes);

            if let Some(cb) = &on_progress {
                let total = total_bytes
                    .map(JsValue::from_f64)
                    .unwrap_or(JsValue::NULL);
                // Callback hatasi ayristirmayi bozmasin.
                let _ = cb.call3(
                    &JsValue::NULL,
                    &JsValue::from_f64(parser.bytes_processed),
                    &total,
                    &JsValue::from_f64(parser.variant_count as f64),
                );
            }
        }
        Ok::<_, JsValue>(())
    }
    .await;

    // Hata olsa da olmasa da kilidi birak (aksi halde stream JS tarafinda kilitli kalir).
    reader.release_lock();
    read_result?;

    parser.finish()
}

/// `File` / `Blob` icin kisayol — `blob.stream()` uzerinden akitarak ayristirir.
///
/// `File` de bir `Blob` oldugu icin `<input type="file">` ciktisini dogrudan verebilirsiniz.
#[wasm_bindgen(js_name = parseBlob)]
pub async fn parse_blob(
    blob: Blob,
    sample_name: Option<String>,
    on_progress: Option<Function>,
) -> Result<VcfParseResult, JsValue> {
    let size = blob.size();
    let stream = blob.stream();
    parse_readable_stream(stream, sample_name, Some(size), on_progress).await
}

// --------------------------------------------------------------------------------------
// Testler (native `cargo test` ile calisir; wasm gerektirmez)
// --------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const VCF: &str = "\
##fileformat=VCFv4.3
##contig=<ID=chr1,length=248956422>
##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">
##FORMAT=<ID=DP,Number=1,Type=Integer,Description=\"Read Depth\">
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tNA12878\tNA12891
chr1\t100\trs1\tA\tG\t50\tPASS\t.\tGT:DP\t0/0:30\t1/1:28
chr1\t200\trs2\tC\tT\t50\tPASS\t.\tGT:DP\t0/1:31\t0/0:22
chr1\t300\trs3\tG\tA\t50\tPASS\t.\tGT:DP\t1|1:19\t1/0:25
chr1\t400\trs4\tT\tC\t50\tPASS\t.\tGT:DP\t./.:0\t0/1:12
chr1\t500\trs5\tA\tG,T\t50\tPASS\t.\tGT:DP\t1/2:44\t0/2:17
chr1\t600\trs6\tA\tG\t50\tPASS\t.\tDP\t33\t21
";

    fn parse_all(src: &str, chunk_size: usize, sample: Option<&str>) -> VcfParseResult {
        parse_filtered(src, chunk_size, sample, &[])
    }

    /// `wanted` bos degilse panel filtresi acilir.
    fn parse_filtered(
        src: &str,
        chunk_size: usize,
        sample: Option<&str>,
        wanted: &[&str],
    ) -> VcfParseResult {
        let mut parser = VcfStreamParser::new(sample.map(String::from));
        if !wanted.is_empty() {
            parser.set_wanted_ids(wanted.iter().map(|s| s.to_string()).collect());
        }
        for chunk in src.as_bytes().chunks(chunk_size) {
            parser.push_chunk_inner(chunk).unwrap();
        }
        parser.finish_inner().unwrap()
    }

    #[test]
    fn dosages_follow_the_mapping_rules() {
        let result = parse_all(VCF, 4096, None);
        // rs1=0/0, rs2=0/1, rs3=1|1, rs4=./., rs5=1/2 ; rs6'da GT yok -> atlanir
        //
        // rs4 CAGIRILAMAMIS: 0 degil DOSAGE_MISSING (3) yazilir. 0 "homozigot
        // referans" demektir ve bu sessiz bir yalandir.
        assert_eq!(result.dosages, vec![0, 1, 2, DOSAGE_MISSING, 2]);
        assert_eq!(result.variant_count, 5);
        assert_eq!(result.missing_genotype_count, 1);
        assert_eq!(result.skipped_line_count, 1);
        assert_eq!(result.sample_name, "NA12878");
        assert_eq!(result.sample_names, vec!["NA12878", "NA12891"]);
    }

    #[test]
    fn second_sample_can_be_selected_by_name() {
        let result = parse_all(VCF, 4096, Some("NA12891"));
        assert_eq!(result.dosages, vec![2, 0, 1, 1, 1]);
    }

    #[test]
    fn chunk_boundaries_do_not_change_the_output() {
        let reference = parse_all(VCF, 4096, None).dosages;
        // 1 bayttan baslayarak her chunk boyutu ayni sonucu vermeli.
        for size in [1, 2, 3, 7, 13, 64, 127] {
            assert_eq!(parse_all(VCF, size, None).dosages, reference, "chunk={size}");
        }
    }

    #[test]
    fn crlf_line_endings_are_tolerated() {
        let crlf = VCF.replace('\n', "\r\n");
        assert_eq!(parse_all(&crlf, 17, None).dosages, vec![0, 1, 2, DOSAGE_MISSING, 2]);
    }

    #[test]
    fn missing_trailing_newline_is_handled() {
        let trimmed = VCF.trim_end_matches('\n');
        assert_eq!(parse_all(trimmed, 33, None).dosages, vec![0, 1, 2, DOSAGE_MISSING, 2]);
    }

    #[test]
    fn missing_genotype_is_not_reported_as_reference() {
        // Bu testin tek isi 0 ile 3'u ayirmak. Eksik veriye 0 yazmak alel
        // frekanslarini sistematik olarak asagi ceker; hatanin tamami budur.
        let result = parse_all(VCF, 4096, None);
        assert_eq!(result.dosages[3], DOSAGE_MISSING);
        assert_ne!(result.dosages[3], 0);
        assert_eq!(result.missing_genotype_count, 1);
    }

    #[test]
    fn panel_filter_keeps_only_wanted_variants_with_their_ids() {
        // PANELE HIZALAMANIN TEMELI: dozajlarin yaninda KIMLIK de cikmali.
        let result = parse_filtered(VCF, 4096, None, &["rs3", "rs1"]);

        assert_eq!(result.ids, vec!["rs1", "rs3"], "kimlikler DOSYA sirasinda cikar");
        assert_eq!(result.dosages, vec![0, 2]);
        assert_eq!(result.variant_count, 2);
        // rs2, rs4, rs5 VE rs6 — dordu de panelde yok.
        //
        // rs6'nin GT alani yok ama filtre GT COZUMUNDEN ONCE calisir, bu yuzden
        // "atlanan satir" degil "panelde yok" sayilir. Sira bilincli: panelde
        // olmayan bir satirin genotipini cozmek bosa is olurdu.
        assert_eq!(result.filtered_out_count, 4);
        assert_eq!(result.skipped_line_count, 0);
    }

    #[test]
    fn panel_filter_keeps_ids_and_dosages_paired() {
        // Eslesme bozulursa hizalama sessizce yanlis olur; boyut esitligi
        // bunun en ucuz kontrolu.
        let result = parse_filtered(VCF, 7, None, &["rs1", "rs4", "rs5"]);
        assert_eq!(result.ids.len(), result.dosages.len());
        assert_eq!(result.ids, vec!["rs1", "rs4", "rs5"]);
        // rs4 cagirilamamis -> eksik isareti.
        assert_eq!(result.dosages, vec![0, DOSAGE_MISSING, 2]);
    }

    #[test]
    fn panel_filter_survives_chunk_boundaries() {
        let reference = parse_filtered(VCF, 4096, None, &["rs1", "rs3", "rs5"]);
        for size in [1, 2, 3, 7, 13, 64] {
            let got = parse_filtered(VCF, size, None, &["rs1", "rs3", "rs5"]);
            assert_eq!(got.dosages, reference.dosages, "chunk={size}");
            assert_eq!(got.ids, reference.ids, "chunk={size}");
        }
    }

    #[test]
    fn without_a_filter_no_ids_are_collected() {
        // Tum genom VCF'inde milyonlarca kimligi bellekte tutmak tarayiciyi
        // sisirirdi; filtresiz modda kimseye lazim da degil.
        let result = parse_all(VCF, 4096, None);
        assert!(result.ids.is_empty());
        assert_eq!(result.filtered_out_count, 0);
    }

    #[test]
    fn unknown_sample_name_is_an_error() {
        let mut parser = VcfStreamParser::new(Some(String::from("YOK")));
        assert!(parser.push_chunk_inner(VCF.as_bytes()).is_err());
    }

    #[test]
    fn data_before_header_is_an_error() {
        let mut parser = VcfStreamParser::new(None);
        assert!(parser.push_chunk_inner(b"chr1\t100\t.\tA\tG\t.\t.\t.\tGT\t0/1\n").is_err());
    }
}

#[cfg(test)]
mod real_data_check {
    use super::*;
    use std::io::Read;

    /// GERCEK 1000 Genomes verisiyle panel filtresi.
    ///
    /// # Bu testin belgeledigi BULGU
    ///
    /// 1000 Genomes faz 3 genotip VCF'lerinde **ID kolonu bostur** (`.`).
    /// Varyant dosyada vardir — ornegin rs4680, `22:19951271 G>A` olarak —
    /// ama ADI yazili degildir.
    ///
    /// Sonuc: rsID'ye gore hizalama bu dosyalarda HICBIR SEY bulamaz.
    /// Bu bir hata degil, gercek verinin bir ozelligidir: kimlik bir
    /// ANOTASYONDUR, ham cagri verisinin parcasi degil. Klinik VCF'lerin
    /// buyuk kismi de boyle gelir.
    ///
    /// Tuketici dosyalari (23andMe, AncestryDNA) rsID TASIR; o yol calisir.
    /// VCF tarafi icin konum+alel eslesmesi gerekir ve bu, panelin ilan
    /// ettigi ASSEMBLY ile dosyanin ayni olmasini sart kosar.
    ///
    /// Dosya depoda yoktur; testi calistirmak icin:
    ///     VERIARFY_TEST_VCF_GZ=/yol/ALL.chr22...vcf.gz cargo test -- --nocapture
    #[test]
    fn thousand_genomes_phase3_has_no_variant_ids() {
        let path = match std::env::var("VERIARFY_TEST_VCF_GZ") {
            Ok(p) => p,
            Err(_) => return, // dosya verilmediyse sessizce atla
        };

        let file = std::fs::File::open(&path).expect("vcf acilamadi");
        let mut gz = flate2::read::MultiGzDecoder::new(file);

        let mut parser = VcfStreamParser::new(None);
        parser.set_wanted_ids(vec!["rs4680".into(), "rs1051730".into()]);

        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = gz.read(&mut buf).expect("gz okunamadi");
            if n == 0 {
                break;
            }
            parser.push_chunk_inner(&buf[..n]).expect("ayristirma hatasi");
        }
        let result = parser.finish_inner().expect("finish hatasi");

        println!("ornek          : {}", result.sample_name);
        println!("ornek sayisi   : {}", result.sample_names.len());
        println!("panelde bulunan: {:?}", result.ids);
        println!("taranan varyant: {}", result.filtered_out_count);

        // Akis SAGLAM calisiyor: milyonlarca varyant sorunsuz tarandi.
        assert!(
            result.filtered_out_count > 1_000_000,
            "chr22 milyonlarca varyant icermeli — akis bozuk"
        );
        assert_eq!(result.sample_names.len(), 2504, "faz 3 panelinde 2504 ornek var");

        // Ve BULGU: kimlik olmadigi icin hicbir eslesme yok.
        assert!(
            result.ids.is_empty(),
            "faz 3 VCF'lerinde ID kolonu bostur; eslesme beklenmiyor"
        );
    }
}
