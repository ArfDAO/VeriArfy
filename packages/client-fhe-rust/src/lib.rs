//! # VeriArfy — Client-Side FHE Encryptor
//!
//! Faz 1'in ([`veriarfy-vcf-parser`]) urettigi `0 | 1 | 2` dozaj vektorunu,
//! tarayicida uretilen bir `ClientKey` ile `FheUint8` olarak sifreler ve
//! IPFS'e/zincire gonderilmeye hazir tek bir bayt blobuna serilestirir.
//!
//! ## Guven modeli
//!
//! `ClientKey` **gizli anahtardir** ve wasm bellegini yalnizca kullanicinin
//! kendi talebiyle ([`FheClient::export_secret_key`]) terk eder. Hesaplamayi
//! yapacak dugume gonderilecek olan sey `ServerKey`'dir; o anahtar sifre
//! **cozemez**, yalnizca sifreli veri uzerinde islem yapmayi mumkun kilar.
//! Blobu alan taraf, gizli anahtar olmadan icerigi okuyamaz.
//!
//! ## Boyut — bu modulu kullanmadan once okuyun
//!
//! Asagidaki rakamlar tahmin degil, bu makinede olculdu (`cargo test --release
//! sizing -- --nocapture`): varsayilan parametrelerle tek bir `FheUint8`
//! **64,3 KB**, tohumlanmis (seeded) hali **0,5 KB** — yani **128 kat** fark.
//!
//! | Girdi | Duz | `encryptDosages` | `encryptDosagesSeeded` |
//! |---|---|---|---|
//! | 1.000 varyant | 1 KB | 62,8 MB | 0,49 MB |
//! | 5.000.000 varyant (WGS) | 5 MB | **~314 GB** | ~2,4 GB |
//!
//! Bu yuzden **tum genomu sifrelemek pratik degildir**; Faz 1'in urettigi
//! vektorden calismanin ilgilendigi bir varyant paneli (birkac yuz - birkac bin
//! SNP) secilmelidir. Varsayilan yol olarak
//! [`FheClient::encrypt_dosages_seeded`] kullanin: ayni gizlilik, 128 kat kucuk
//! blob. Duz `encryptDosages` yalnizca dogrudan homomorfik isleme girecek kucuk
//! kumeler icindir.
//!
//! Anahtar boyutlari da ayni olcumden: `ClientKey` 30 KB (kullanicida kalir),
//! `CompressedServerKey` 57 MB (hesaplayan duguma bir kez gonderilir).

use js_sys::Uint8Array;
use serde::{Deserialize, Serialize};
use tfhe::prelude::*;
use tfhe::{
    ClientKey, CompressedFheUint8, CompressedServerKey, ConfigBuilder, FheUint8,
    generate_keys,
};
use wasm_bindgen::prelude::*;

pub mod pubkey;

/// Blob format surumu. Cozucu tarafin uyumsuz bir blobu sessizce yanlis
/// yorumlamamasi icin serilestirilen her yapiya yazilir.
const FORMAT_VERSION: u16 = 2;

/// Modul ici hata tipi.
///
/// `JsValue` yalnizca wasm hedefinde uretilebildigi icin ic mantik bu tipi
/// kullanir; boylece sifreleme/cozme yollari native `cargo test` ile de
/// dogrulanabilir. Cevirim tek noktada, API sinirinda yapilir.
#[derive(Debug)]
pub struct FheError(String);

impl std::fmt::Display for FheError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<FheError> for JsValue {
    fn from(e: FheError) -> Self {
        JsError::new(&e.0).into()
    }
}

pub(crate) fn err(msg: impl std::fmt::Display) -> FheError {
    FheError(msg.to_string())
}

// --------------------------------------------------------------------------------------
// Blob semasi
// --------------------------------------------------------------------------------------

/// Sifreli dozajlarin tasima bicimi.
///
/// `bincode` ile tek parca bayt dizisine cevrilir; IPFS'e bu hali konur,
/// zincire de bu blobun ozeti (hash) yazilir.
#[derive(Serialize, Deserialize)]
struct EncryptedDosages {
    version: u16,
    /// Kac dozaj sifrelendi — cozmeden once dogrulama icin.
    count: u32,
    /// Hangi varyant indeksleri secildi. Tam vektor sifrelendiyse `None`.
    ///
    /// Panel, calismanin herkese acik tanimidir (tum katilimcilarda ayni), bu
    /// yuzden blobun icinde tasinmasi katilimci hakkinda hicbir sey sizdirmaz.
    /// Buna karsilik hesaplayan tarafin "bu blobun 7. elemani hangi SNP?"
    /// sorusunu ayri bir dosyaya bakmadan yanitlamasini saglar — panel ile
    /// veri arasinda sessiz hizasizlik olusmasini engeller.
    panel: Option<Vec<u32>>,
    payload: Payload,
}

/// Blobun yalnizca basligi.
///
/// `bincode` alanlari sirayla yazdigi icin, `deserialize_from` ile bu yapiya
/// okumak sifreli metinlere hic dokunmadan basligi cozer — 500 varyantlik bir
/// blobun ne oldugunu ogrenmek icin 500 ciphertext ayristirmak gerekmez.
#[derive(Deserialize)]
struct BlobHeader {
    version: u16,
    count: u32,
    panel: Option<Vec<u32>>,
}

#[derive(Serialize, Deserialize)]
enum Payload {
    /// Dogrudan homomorfik isleme girebilen tam sifreli metinler.
    Plain(Vec<FheUint8>),
    /// Tohumlanmis (seeded) sifreli metinler — cok daha kucuk, isleme
    /// girmeden once `decompress()` gerekir.
    Seeded(Vec<CompressedFheUint8>),
}

// --------------------------------------------------------------------------------------
// Istemci
// --------------------------------------------------------------------------------------

/// Gizli anahtari tutan ve sifrelemeyi yapan istemci.
///
/// Kullanim (JS):
/// ```js
/// const client = FheClient.generate();          // yavas: anahtar uretimi
/// const blob   = client.encryptDosagesSeeded(dosages);
/// const secret = client.exportSecretKey();      // kullanici saklar
/// ```
#[wasm_bindgen]
pub struct FheClient {
    client_key: ClientKey,
}

#[wasm_bindgen]
impl FheClient {
    /// Yeni bir gizli anahtar uretir.
    ///
    /// Parametreler `ConfigBuilder::default()` ile gelir — Zama'nin `FheUint8`
    /// icin onerdigi varsayilan shortint parametre kumesi (2 bit mesaj +
    /// 2 bit carry blok, 128-bit klasik guvenlik).
    ///
    /// Maliyetlidir (tarayicida ~1-3 sn) ve senkron calisir; **mutlaka bir Web
    /// Worker icinde** cagirin, yoksa arayuz kilitlenir.
    #[wasm_bindgen(js_name = generate)]
    pub fn generate() -> FheClient {
        Self::generate_inner()
    }

    /// Daha once `exportSecretKey` ile disari alinmis anahtari geri yukler.
    ///
    /// Kullanici ikinci kez veri gonderirken ayni anahtarla sifrelemelidir,
    /// aksi halde eski ve yeni blobu birlikte cozmek mumkun olmaz.
    #[wasm_bindgen(js_name = fromSecretKey)]
    pub fn from_secret_key(bytes: &[u8]) -> Result<FheClient, JsValue> {
        Self::from_secret_key_inner(bytes).map_err(JsValue::from)
    }

    /// Gizli anahtari disari verir. **Bu baytlar sifreyi cozer** — asla aga
    /// gonderilmemeli, yalnizca kullanicinin kendi cihazinda saklanmali.
    #[wasm_bindgen(js_name = exportSecretKey)]
    pub fn export_secret_key(&self) -> Result<Uint8Array, JsValue> {
        to_js(self.export_secret_key_inner())
    }

    /// Hesaplamayi yapacak dugume gonderilecek `ServerKey` (sikistirilmis).
    ///
    /// Bu anahtar sifre cozemez; sifreli veri uzerinde toplama/karsilastirma
    /// gibi islemleri mumkun kilar. Boyutu buyuktur, bir kez uretilip paylasilir.
    #[wasm_bindgen(js_name = exportServerKey)]
    pub fn export_server_key(&self) -> Result<Uint8Array, JsValue> {
        to_js(self.export_server_key_inner())
    }

    /// Dozaj vektorunu tam (sikistirilmamis) `FheUint8` olarak sifreler.
    ///
    /// Cikti dogrudan homomorfik isleme girebilir ama **cok buyuktur**
    /// (olculen: eleman basina 64,3 KB). Yalnizca kucuk kumeler icin kullanin;
    /// aksi halde `encryptDosagesSeeded` tercih edilmeli.
    #[wasm_bindgen(js_name = encryptDosages)]
    pub fn encrypt_dosages(&self, values: &[u8]) -> Result<Uint8Array, JsValue> {
        to_js(self.encrypt_inner(values, false))
    }

    /// Dozaj vektorunu tohumlanmis (seeded) sifreli metin olarak sifreler.
    ///
    /// Maske, rastgele baytlar yerine bir tohumdan turetildigi icin blob 128
    /// kat kuculur (64,3 KB -> 0,5 KB); guvenlik seviyesi aynidir. Hesaplayan dugum, isleme
    /// sokmadan once `decompress()` cagirir.
    #[wasm_bindgen(js_name = encryptDosagesSeeded)]
    pub fn encrypt_dosages_seeded(&self, values: &[u8]) -> Result<Uint8Array, JsValue> {
        to_js(self.encrypt_inner(values, true))
    }

    /// Blobu geri cozer — gonderim oncesi dogrulama ve testler icin.
    ///
    /// Uretim akisinda cozme islemi normalde sonuclari alan tarafta yapilir;
    /// burada "gonderdigim sey gercekten benim verim mi" kontrolu icin durur.
    #[wasm_bindgen(js_name = decryptDosages)]
    pub fn decrypt_dosages(&self, blob: &[u8]) -> Result<Uint8Array, JsValue> {
        to_js(self.decrypt_inner(blob))
    }

    /// Faz 1'in tam dozaj vektorunden yalnizca **panel indekslerini** secip
    /// tohumlanmis olarak sifreler — uretimde kullanilacak varsayilan yol.
    ///
    /// `indices`, calismanin ilgilendigi varyantlarin Faz 1 ciktisi icindeki
    /// sirasidir. **Verilen sira korunur**: ciktinin i. elemani
    /// `indices[i]`'in dozajidir, cunku FHE devresi panelin sirasina gore
    /// yazilir. Panel indeksleri bloba da yazilir (bkz. `blobInfo`).
    #[wasm_bindgen(js_name = encryptPanelSeeded)]
    pub fn encrypt_panel_seeded(
        &self,
        values: &[u8],
        indices: &[u32],
    ) -> Result<Uint8Array, JsValue> {
        to_js(self.encrypt_panel_inner(values, indices, true))
    }

    /// `encryptPanelSeeded`'in sikistirilmamis karsiligi. Cok buyuk cikti
    /// uretir; yalnizca dogrudan homomorfik isleme girecek kucuk paneller icin.
    #[wasm_bindgen(js_name = encryptPanel)]
    pub fn encrypt_panel(&self, values: &[u8], indices: &[u32]) -> Result<Uint8Array, JsValue> {
        to_js(self.encrypt_panel_inner(values, indices, false))
    }

    /// Tek bir sifreli dozajin bayt maliyeti — arayuzde "bu panel N MB olacak"
    /// uyarisi gosterebilmek icin olculur (tahmin degil, gercek olcum).
    #[wasm_bindgen(js_name = ciphertextSizeBytes)]
    pub fn ciphertext_size_bytes(&self, seeded: bool) -> Result<u32, JsValue> {
        self.encrypt_one(0, seeded)
            .map(|n| n as u32)
            .map_err(JsValue::from)
    }
}

fn to_js(result: Result<Vec<u8>, FheError>) -> Result<Uint8Array, JsValue> {
    let bytes = result?;
    Ok(Uint8Array::from(&bytes[..]))
}

// --------------------------------------------------------------------------------------
// Panel secimi
// --------------------------------------------------------------------------------------

/// Tam dozaj vektorunden panel indekslerini secer — **sifrelemeden**.
///
/// Arayuzde "bu panel su kadar varyant tutuyor" onizlemesi yapmak ve paneli
/// sifrelemeden once dogrulamak icin. Anahtar gerektirmez, aninda doner.
#[wasm_bindgen(js_name = selectPanel)]
pub fn select_panel(values: &[u8], indices: &[u32]) -> Result<Uint8Array, JsValue> {
    let selected = select(values, indices)?;
    Ok(Uint8Array::from(&selected[..]))
}

/// Panel indekslerini dogrular ve karsilik gelen dozajlari **verilen sirada**
/// toplar.
///
/// Iki durum sessizce gecmez, cunku ikisi de FHE devresinin panel tanimiyla
/// hizasini bozar ve sonucu fark edilmeden yanlislastirir:
///
/// - **Sinir disi indeks**: kullanici baska bir referans surumuyle uretilmis
///   VCF yuklemis olabilir; eksik eleman atlanirsa sonraki her sey kayar.
/// - **Tekrarlanan indeks**: homomorfik toplamda ayni varyanti iki kez sayar.
pub(crate) fn select(values: &[u8], indices: &[u32]) -> Result<Vec<u8>, FheError> {
    let mut seen = std::collections::HashSet::with_capacity(indices.len());
    let mut out = Vec::with_capacity(indices.len());

    for (rank, &idx) in indices.iter().enumerate() {
        let Some(&value) = values.get(idx as usize) else {
            return Err(err(format!(
                "panelin {rank}. indeksi ({idx}) dozaj vektorunun disinda (vektor uzunlugu {})",
                values.len()
            )));
        };

        if !seen.insert(idx) {
            return Err(err(format!(
                "panelde tekrarlanan indeks: {idx} ({rank}. sirada)"
            )));
        }

        out.push(value);
    }

    Ok(out)
}

// --------------------------------------------------------------------------------------
// Blob basligi
// --------------------------------------------------------------------------------------

/// Bir blobun ne oldugunu **cozmeden** soyler.
///
/// Alici taraf gizli anahtara sahip olmadan eleman sayisini ve paneli gorebilir;
/// boylece yanlis panelle uretilmis bir blob islenmeye baslamadan reddedilir.
#[wasm_bindgen(js_name = blobInfo)]
pub fn blob_info(blob: &[u8]) -> Result<BlobInfo, JsValue> {
    let header: BlobHeader = bincode::deserialize_from(std::io::Cursor::new(blob))
        .map_err(|e| err(format!("blob basligi okunamadi: {e}")))?;

    if header.version != FORMAT_VERSION {
        return Err(err(format!(
            "desteklenmeyen blob surumu: {} (beklenen {FORMAT_VERSION})",
            header.version
        ))
        .into());
    }

    Ok(BlobInfo {
        version: header.version,
        count: header.count,
        panel: header.panel,
        size_bytes: blob.len() as u32,
    })
}

/// [`blob_info`] ciktisi.
#[wasm_bindgen]
pub struct BlobInfo {
    version: u16,
    count: u32,
    panel: Option<Vec<u32>>,
    size_bytes: u32,
}

#[wasm_bindgen]
impl BlobInfo {
    #[wasm_bindgen(getter)]
    pub fn version(&self) -> u16 {
        self.version
    }

    /// Blobdaki sifreli dozaj sayisi.
    #[wasm_bindgen(getter)]
    pub fn count(&self) -> u32 {
        self.count
    }

    /// Panel indeksleri; tam vektor sifrelendiyse `undefined`.
    #[wasm_bindgen(getter)]
    pub fn panel(&self) -> Option<Vec<u32>> {
        self.panel.clone()
    }

    #[wasm_bindgen(getter, js_name = sizeBytes)]
    pub fn size_bytes(&self) -> u32 {
        self.size_bytes
    }
}

// -- wasm_bindgen'e acilmayan ic mantik ---------------------------------------------------

impl FheClient {
    fn generate_inner() -> Self {
        let config = ConfigBuilder::default().build();
        // ServerKey burada uretilse de istemcide tutulmaz: sifreleme ve cozme
        // icin gerekli degildir, yalnizca hesaplayan dugum icin anlamlidir.
        let (client_key, _server_key) = generate_keys(config);
        Self { client_key }
    }

    fn from_secret_key_inner(bytes: &[u8]) -> Result<Self, FheError> {
        let client_key: ClientKey =
            bincode::deserialize(bytes).map_err(|e| err(format!("gizli anahtar okunamadi: {e}")))?;
        Ok(Self { client_key })
    }

    fn export_secret_key_inner(&self) -> Result<Vec<u8>, FheError> {
        bincode::serialize(&self.client_key)
            .map_err(|e| err(format!("gizli anahtar serilestirilemedi: {e}")))
    }

    fn export_server_key_inner(&self) -> Result<Vec<u8>, FheError> {
        let server_key = CompressedServerKey::new(&self.client_key);
        bincode::serialize(&server_key)
            .map_err(|e| err(format!("sunucu anahtari serilestirilemedi: {e}")))
    }

    /// Dozajlari sifreler ve surum basligiyla birlikte tek bloba serilestirir.
    fn encrypt_inner(&self, values: &[u8], seeded: bool) -> Result<Vec<u8>, FheError> {
        let payload = self.build_payload(values, seeded);

        let envelope = EncryptedDosages {
            version: FORMAT_VERSION,
            count: values.len() as u32,
            panel: None,
            payload,
        };

        bincode::serialize(&envelope)
            .map_err(|e| err(format!("sifreli veri serilestirilemedi: {e}")))
    }

    /// Panel secip sifreler. Secim once dogrulanir; hatali panelde hicbir sey
    /// sifrelenmeden hata doner.
    fn encrypt_panel_inner(
        &self,
        values: &[u8],
        indices: &[u32],
        seeded: bool,
    ) -> Result<Vec<u8>, FheError> {
        let selected = select(values, indices)?;
        let payload = self.build_payload(&selected, seeded);

        let envelope = EncryptedDosages {
            version: FORMAT_VERSION,
            count: selected.len() as u32,
            panel: Some(indices.to_vec()),
            payload,
        };

        bincode::serialize(&envelope)
            .map_err(|e| err(format!("sifreli veri serilestirilemedi: {e}")))
    }

    fn decrypt_inner(&self, blob: &[u8]) -> Result<Vec<u8>, FheError> {
        let envelope: EncryptedDosages =
            bincode::deserialize(blob).map_err(|e| err(format!("blob okunamadi: {e}")))?;

        if envelope.version != FORMAT_VERSION {
            return Err(err(format!(
                "desteklenmeyen blob surumu: {} (beklenen {FORMAT_VERSION})",
                envelope.version
            )));
        }

        let values: Vec<u8> = match envelope.payload {
            Payload::Plain(cts) => cts.iter().map(|ct| ct.decrypt(&self.client_key)).collect(),
            Payload::Seeded(cts) => cts
                .iter()
                .map(|ct| ct.decompress().decrypt(&self.client_key))
                .collect(),
        };

        if values.len() as u32 != envelope.count {
            return Err(err(format!(
                "blob tutarsiz: basligi {} eleman diyor, govdesinde {} var",
                envelope.count,
                values.len()
            )));
        }

        Ok(values)
    }

    fn build_payload(&self, values: &[u8], seeded: bool) -> Payload {
        if seeded {
            Payload::Seeded(
                values
                    .iter()
                    .map(|&v| CompressedFheUint8::encrypt(v, &self.client_key))
                    .collect(),
            )
        } else {
            Payload::Plain(
                values
                    .iter()
                    .map(|&v| FheUint8::encrypt(v, &self.client_key))
                    .collect(),
            )
        }
    }

    fn encrypt_one(&self, value: u8, seeded: bool) -> Result<usize, FheError> {
        let bytes = if seeded {
            bincode::serialize(&CompressedFheUint8::encrypt(value, &self.client_key))
        } else {
            bincode::serialize(&FheUint8::encrypt(value, &self.client_key))
        };
        bytes
            .map(|b| b.len())
            .map_err(|e| err(format!("olcum serilestirmesi basarisiz: {e}")))
    }
}

// --------------------------------------------------------------------------------------
// Testler
// --------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn client() -> FheClient {
        FheClient::generate_inner()
    }

    fn decrypt(c: &FheClient, blob: &[u8]) -> Vec<u8> {
        c.decrypt_inner(blob).unwrap()
    }

    #[test]
    fn seeded_roundtrip_preserves_dosages() {
        let c = client();
        let dosages = [0u8, 1, 2, 2, 0, 1, 0, 2];
        let blob = c.encrypt_inner(&dosages, true).unwrap();
        assert_eq!(decrypt(&c, &blob), dosages);
    }

    #[test]
    fn plain_roundtrip_preserves_dosages() {
        let c = client();
        let dosages = [2u8, 0, 1];
        let blob = c.encrypt_inner(&dosages, false).unwrap();
        assert_eq!(decrypt(&c, &blob), dosages);
    }

    #[test]
    fn exported_key_decrypts_what_the_original_encrypted() {
        let c = client();
        let blob = c.encrypt_inner(&[1, 2, 0], true).unwrap();

        let exported = c.export_secret_key_inner().unwrap();
        let restored = FheClient::from_secret_key_inner(&exported).unwrap();

        assert_eq!(decrypt(&restored, &blob), vec![1, 2, 0]);
    }

    #[test]
    fn a_different_key_cannot_read_the_blob() {
        let alice = client();
        let mallory = client();
        let blob = alice.encrypt_inner(&[0, 1, 2], true).unwrap();

        // Yanlis anahtar cozmeyi reddetmez — anlamsiz deger uretir.
        // Kritik olan: gercek dozajlari ELE VERMEMESI.
        let garbage = decrypt(&mallory, &blob);
        assert_ne!(garbage, vec![0, 1, 2]);
    }

    #[test]
    fn empty_input_produces_a_valid_empty_blob() {
        let c = client();
        let blob = c.encrypt_inner(&[], true).unwrap();
        assert!(decrypt(&c, &blob).is_empty());
    }

    // --- Panel secimi ---------------------------------------------------------

    #[test]
    fn panel_selects_only_the_requested_indices_in_the_given_order() {
        let full = [0u8, 1, 2, 0, 1, 2, 0, 1, 2, 0];
        // Bilincli olarak sirasiz: cikti panelin sirasini izlemeli.
        let panel = [8u32, 1, 5];
        assert_eq!(select(&full, &panel).unwrap(), vec![2, 1, 2]);
    }

    #[test]
    fn panel_encrypt_roundtrips_only_the_panel() {
        let c = client();
        let full = [0u8, 1, 2, 0, 1, 2, 0, 1, 2, 0];
        let panel = [9u32, 2, 4];

        let blob = c.encrypt_panel_inner(&full, &panel, true).unwrap();
        assert_eq!(decrypt(&c, &blob), vec![0, 2, 1]);
    }

    #[test]
    fn out_of_range_index_is_rejected_instead_of_shifting_the_panel() {
        let full = [0u8, 1, 2];
        let e = select(&full, &[0, 7]).unwrap_err().to_string();
        assert!(e.contains("7"), "{e}");
        assert!(e.contains("disinda"), "{e}");
    }

    #[test]
    fn duplicate_index_is_rejected() {
        let full = [0u8, 1, 2];
        let e = select(&full, &[1, 2, 1]).unwrap_err().to_string();
        assert!(e.contains("tekrarlanan"), "{e}");
    }

    #[test]
    fn a_bad_panel_encrypts_nothing() {
        let c = client();
        // Hatali panel, pahali sifreleme hic baslamadan reddedilmeli.
        assert!(c.encrypt_panel_inner(&[0, 1, 2], &[0, 99], true).is_err());
    }

    #[test]
    fn header_is_readable_without_decrypting() {
        let c = client();
        let full: Vec<u8> = (0..50).map(|i| (i % 3) as u8).collect();
        let panel = [3u32, 17, 42];

        let blob = c.encrypt_panel_inner(&full, &panel, true).unwrap();
        let header: BlobHeader =
            bincode::deserialize_from(std::io::Cursor::new(&blob[..])).unwrap();

        assert_eq!(header.version, FORMAT_VERSION);
        assert_eq!(header.count, 3);
        assert_eq!(header.panel.unwrap(), panel);
    }

    #[test]
    fn full_vector_blob_carries_no_panel() {
        let c = client();
        let blob = c.encrypt_inner(&[0, 1, 2], true).unwrap();
        let header: BlobHeader =
            bincode::deserialize_from(std::io::Cursor::new(&blob[..])).unwrap();
        assert!(header.panel.is_none());
    }

    #[test]
    fn panel_shrinks_the_blob_proportionally() {
        let c = client();
        let full: Vec<u8> = (0..1000).map(|i| (i % 3) as u8).collect();
        let panel: Vec<u32> = (0..100).collect();

        let all = c.encrypt_inner(&full, true).unwrap().len();
        let subset = c.encrypt_panel_inner(&full, &panel, true).unwrap().len();

        // 100/1000 secildi: blob da kabaca onda birine inmeli.
        assert!(subset * 5 < all, "panel {subset} B, tamami {all} B");
    }

    #[test]
    fn corrupt_blob_is_rejected() {
        let c = client();
        assert!(c.decrypt_inner(&[0xde, 0xad, 0xbe, 0xef]).is_err());
    }

    #[test]
    fn seeded_ciphertext_is_much_smaller_than_plain() {
        let c = client();
        let seeded = c.encrypt_one(1, true).unwrap();
        let plain = c.encrypt_one(1, false).unwrap();

        println!("seeded: {seeded} B, plain: {plain} B, oran: {}x", plain / seeded.max(1));
        assert!(seeded * 10 < plain, "seeded {seeded} B, plain {plain} B");
    }
}

#[cfg(test)]
mod sizing {
    use super::*;

    #[test]
    fn report_real_sizes() {
        let c = FheClient::generate_inner();
        let plain_one = c.encrypt_one(1, false).unwrap();
        let seeded_one = c.encrypt_one(1, true).unwrap();

        let n = 1000usize;
        let values: Vec<u8> = (0..n).map(|i| (i % 3) as u8).collect();
        let plain_blob = c.encrypt_inner(&values, false).unwrap().len();
        let seeded_blob = c.encrypt_inner(&values, true).unwrap().len();

        let sk = c.export_secret_key_inner().unwrap().len();
        let svk = c.export_server_key_inner().unwrap().len();

        let kb = |b: usize| format!("{:.1} KB", b as f64 / 1024.0);
        let mb = |b: usize| format!("{:.2} MB", b as f64 / 1048576.0);

        println!("\n=== OLCUM ===");
        println!("FheUint8 (plain)      : {}", kb(plain_one));
        println!("FheUint8 (seeded)     : {}", kb(seeded_one));
        println!("oran                  : {:.0}x", plain_one as f64 / seeded_one as f64);
        println!("1000 dozaj  plain blob: {}", mb(plain_blob));
        println!("1000 dozaj seeded blob: {}", mb(seeded_blob));
        println!("ClientKey             : {}", mb(sk));
        println!("CompressedServerKey   : {}", mb(svk));
        println!("=============");
    }
}
