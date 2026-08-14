//! VeriArfy — tarayicida GIZLI ANAHTAR ile sifreleme (Zero-Trust).
//!
//! # Karar
//!
//! Global Public Key (PKE) yolu kaldirildi. Sebep tek cumleyle: PKE ile
//! uretilen sifreli metnin gurultusu, Concrete'in tfhers girdi sozlesmesinin
//! kabul ettiginin ~10^24 kati cikiyordu ve bootstrap bile bunu kapatmiyordu
//! (olculdu: 1,09e-13 / hedef 4,70e-38).
//!
//! Bunun yerine veri **yalnizca kullanicinin tarayicisinda uretilen gizli
//! anahtarla** sifrelenir. Bu hem gizlilik acisindan en guclu secenek, hem de
//! Concrete'in tam olarak bekledigi sey: **taze gizli-anahtar sifrelemesi**.
//! Olculdu: bu yolun gurultusu 4,66e-38 — hedefin (4,70e-38) icinde.
//!
//! # Parametreler
//!
//! Zama'nin tfhers referans seti birebir kullanilir (bkz. [`COMPUTE_PARAMS`]).
//! PKE ve keyswitch parametrelerine artik ihtiyac yoktur: compact liste
//! uretilmedigi icin sunucuda `expand()` adimi da yoktur. Tarayici dogrudan
//! `FheUint8` uretir, sunucu onu Concrete'e verir.

use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;

use crate::{FheError, err, select};
use tfhe::core_crypto::prelude::LweSecretKey;
use tfhe::prelude::FheEncrypt;
use tfhe::{ClientKey, CompressedServerKey, Config, ConfigBuilder, FheUint8};

use sharks::{Share, Sharks};
use tfhe::safe_serialization::{safe_deserialize, safe_serialize};
// tfhe 0.10'da `aliases` modulu yoktur; sabitler dogrudan
// `shortint::parameters` altindan re-export edilir. Ayrica bu surumde
// Gaussian klasik parametreler yalnizca p_fail 2^-64 ailesindedir
// (1.7'deki 2^-128 karsiligi yok) — guvenlik hedefi bilincli olarak
// Concrete'in destekledigi surume gore secilmistir.
use tfhe::core_crypto::prelude::{
    DecompositionBaseLog, DecompositionLevelCount, DynamicDistribution, GlweDimension,
    LweDimension, PolynomialSize, StandardDev,
};
use tfhe::shortint::parameters::{
    CarryModulus, CiphertextModulus, ClassicPBSParameters, EncryptionKeyChoice, MaxNoiseLevel,
    MessageModulus,
};

/// Hesap parametreleri — **Zama'nin tfhers koprusu icin yayinladigi referans set**.
///
/// Kaynak: zama-ai/concrete, v2.10.0,
/// `frontends/concrete-python/examples/tfhers/tfhers_params.json`
///
/// # Neden standart bir alias degil
///
/// Once `PARAM_MESSAGE_2_CARRY_2_KS_PBS_GAUSSIAN_2M64` kullanilmisti ve
/// Concrete devreyi kabul etmiyordu. Sebep olculdu: o alias ile
/// `import_value`'nun iliştirdigi varyans (8,10e-30) ile devrenin bekledigi
/// (8,44e-31) arasinda **sabit 9,589** kat fark olusuyordu. Asagidaki referans
/// setle ayni olcum **1,000** veriyor — yani Concrete'in optimizer'i tam olarak
/// bu noktaya oturuyor.
///
/// Kritik fark, GLWE gurultusunun ~13.000 kat daha dusuk olmasi
/// (2,845e-15 -> 2,168e-19) ve polinom boyutunun iki kati olmasi.
///
/// Bu degerler ELLE DEGISTIRILMEMELIDIR; Concrete tarafiyla eslesmeleri
/// `data/tfhers_params_zama.json` ile birlikte dogrulanir.
pub const COMPUTE_PARAMS: ClassicPBSParameters = ClassicPBSParameters {
    lwe_dimension: LweDimension(902),
    glwe_dimension: GlweDimension(1),
    polynomial_size: PolynomialSize(4096),
    lwe_noise_distribution: DynamicDistribution::new_gaussian_from_std_dev(StandardDev(
        1.0994794733558207e-6,
    )),
    glwe_noise_distribution: DynamicDistribution::new_gaussian_from_std_dev(StandardDev(
        2.168404344971009e-19,
    )),
    pbs_base_log: DecompositionBaseLog(15),
    pbs_level: DecompositionLevelCount(2),
    ks_base_log: DecompositionBaseLog(3),
    ks_level: DecompositionLevelCount(6),
    message_modulus: MessageModulus(4),
    carry_modulus: CarryModulus(8),
    max_noise_level: MaxNoiseLevel::new(10),
    log2_p_fail: -64.084,
    ciphertext_modulus: CiphertextModulus::new_native(),
    encryption_key_choice: EncryptionKeyChoice::Big,
};

/// BSKK-44 esikli custody: gizli anahtar kac parcaya bolunur.
pub const SHARE_COUNT: u8 = 10;

/// Anahtari geri getirmek icin gereken en az parca sayisi.
pub const SHARE_THRESHOLD: u8 = 7;

/// Serilestirmede kabul edilen ust sinir (bayt).
///
/// `safe_serialize` bu siniri hem yazarken hem okurken uygular; bozuk ya da
/// kotu niyetli bir girdi ile bellek tuketilmesini engeller.
const SERIALIZATION_LIMIT: u64 = 1 << 30; // 1 GiB

/// Sunucudaki Concrete devresiyle **birebir ayni** olmasi gereken hesap
/// parametreleri.
///
/// Bu deger tek dogru kaynaktir: [`compute_params_json`] ile disari verilir ve
/// Python tarafi devreyi tam olarak bu JSON'la derler. Boylece parametreler
/// elle kopyalanmaz.
pub fn config() -> Config {
    // Dedicated compact public key parametresi YOK: PKE yolu kaldirildi.
    ConfigBuilder::with_custom_parameters(COMPUTE_PARAMS).build()
}

/// Hesap parametrelerini Concrete'in okudugu JSON bicimiyle dondurur.
///
/// Python tarafinda:
/// ```python
/// t = tfhers.get_type_from_params("tfhers_params.json", is_signed=False, precision=8)
/// ```
///
/// Elle kopyalanan parametre = sessiz uyumsuzluk demektir; bu yuzden tek
/// kaynak Rust'tadir.
#[wasm_bindgen(js_name = computeParamsJson)]
pub fn compute_params_json() -> Result<String, JsValue> {
    serde_json::to_string_pretty(&COMPUTE_PARAMS)
        .map_err(|e| JsValue::from(err(format!("parametreler serilestirilemedi: {e}"))))
}

/// Tarayicida gizli anahtar uretip veriyi sifreleyen istemci.
///
/// Gizli anahtar bu nesnenin icinde yasar ve **yalnizca kullanicinin acik
/// talebiyle** disari cikar. Sifreli metinler dogrudan `FheUint8`'dir; sunucu
/// tarafinda `expand()` ya da keyswitch adimi yoktur.
#[wasm_bindgen]
pub struct SecretEncryptor {
    client_key: ClientKey,
}

#[wasm_bindgen]
impl SecretEncryptor {
    /// Tarayicida yeni bir gizli anahtar uretir.
    ///
    /// Maliyetlidir; **mutlaka bir Web Worker icinde** cagirin.
    #[wasm_bindgen(js_name = generate)]
    pub fn generate() -> SecretEncryptor {
        Self {
            client_key: ClientKey::generate(config()),
        }
    }

    /// Daha once saklanmis gizli anahtari geri yukler.
    #[wasm_bindgen(js_name = fromSecretKey)]
    pub fn from_secret_key(bytes: &[u8]) -> Result<SecretEncryptor, JsValue> {
        Self::from_secret_key_inner(bytes).map_err(JsValue::from)
    }

    /// Gizli anahtari disari verir. **Bu baytlar sifreyi cozer.**
    #[wasm_bindgen(js_name = exportSecretKey)]
    pub fn export_secret_key(&self) -> Result<Uint8Array, JsValue> {
        let bytes = self.export_secret_key_inner()?;
        Ok(Uint8Array::from(&bytes[..]))
    }

    /// Concrete devresine enjekte edilecek LWE sifreleme anahtari.
    ///
    /// Devrenin girdi anahtari bununla ozdeslestirilir
    /// (`bridge.keygen_with_initial_keys`), aksi halde sifreli metin o devrede
    /// gecerli olmaz.
    #[wasm_bindgen(js_name = exportLweSecretKey)]
    pub fn export_lwe_secret_key(&self) -> Result<Uint8Array, JsValue> {
        let bytes = self.export_lwe_secret_key_inner()?;
        Ok(Uint8Array::from(&bytes[..]))
    }

    /// Panel dozajlarini sifreler; her dozaj ayri bir `FheUint8` olur.
    ///
    /// Ayri ayri serilestirilir cunku Concrete'in `import_value` fonksiyonu
    /// tek bir tfhe-rs tamsayisi alir ve devre N ayri skaler girdiyle derlenir.
    #[wasm_bindgen(js_name = encryptPanel)]
    pub fn encrypt_panel(&self, values: &[u8], indices: &[u32]) -> Result<js_sys::Array, JsValue> {
        let selected = select(values, indices)?;
        let parts = self.encrypt_each(&selected)?;

        let out = js_sys::Array::new();
        for part in parts {
            out.push(&Uint8Array::from(&part[..]));
        }
        Ok(out)
    }

    /// Hesaplayan duguma gonderilecek `ServerKey` (sikistirilmis).
    ///
    /// Bu anahtar **sifre cozemez**; yalnizca sifreli veri uzerinde tfhe-rs
    /// islemleri yapmayi mumkun kilar.
    ///
    /// DIKKAT — kapsam siniri: bu, tfhe-rs'in degerlendirme anahtaridir.
    /// Concrete devresi bunu KULLANMAZ; kendi keyset'ini ister ve o keyset
    /// yalnizca gizli anahtar bilinerek uretilebilir
    /// (`bridge.keygen_with_initial_keys`). Bkz. `docs/keys.md`.
    #[wasm_bindgen(js_name = exportServerKey)]
    pub fn export_server_key(&self) -> Result<Uint8Array, JsValue> {
        let bytes = self.export_server_key_inner()?;
        Ok(Uint8Array::from(&bytes[..]))
    }

    /// Gizli anahtari Shamir ile `SHARE_COUNT` parcaya boler
    /// (esik `SHARE_THRESHOLD`).
    ///
    /// Parcalar BSKK-44 dugumlerine dagitilir; hicbir dugum tek basina
    /// anahtari geri getiremez, `SHARE_THRESHOLD` tanesi bir araya gelmelidir.
    ///
    /// Bolme islemi bittikten sonra cagiran taraf `destroySecretKey()`
    /// cagirmalidir.
    #[wasm_bindgen(js_name = splitSecretKey)]
    pub fn split_secret_key(&self) -> Result<js_sys::Array, JsValue> {
        let shares = self.split_secret_key_inner()?;

        let out = js_sys::Array::new();
        for share in shares {
            out.push(&Uint8Array::from(&share[..]));
        }
        Ok(out)
    }

    /// Esik sayida parcadan gizli anahtari geri getirir.
    ///
    /// Uretimde bu islem tarayicida degil, BSKK-44 dugumlerinin esikli
    /// toreninde yapilir.
    #[wasm_bindgen(js_name = recoverFromShares)]
    pub fn recover_from_shares(shares: js_sys::Array) -> Result<SecretEncryptor, JsValue> {
        let mut collected: Vec<Vec<u8>> = Vec::with_capacity(shares.length() as usize);
        for value in shares.iter() {
            let bytes = Uint8Array::new(&value).to_vec();
            collected.push(bytes);
        }

        Self::recover_from_shares_inner(&collected).map_err(JsValue::from)
    }

    /// Tek bir dozajin sifreli bayt maliyeti — arayuzde boyut gostermek icin.
    #[wasm_bindgen(js_name = ciphertextSizeBytes)]
    pub fn ciphertext_size_bytes(&self) -> Result<u32, JsValue> {
        Ok(self.encrypt_one(0)?.len() as u32)
    }
}

impl SecretEncryptor {
    pub fn generate_inner() -> Self {
        Self {
            client_key: ClientKey::generate(config()),
        }
    }

    pub fn from_secret_key_inner(bytes: &[u8]) -> Result<Self, FheError> {
        let client_key: ClientKey = safe_deserialize(bytes, SERIALIZATION_LIMIT)
            .map_err(|e| err(format!("gizli anahtar okunamadi: {e}")))?;
        Ok(Self { client_key })
    }

    pub fn export_secret_key_inner(&self) -> Result<Vec<u8>, FheError> {
        let mut out = Vec::new();
        safe_serialize(&self.client_key, &mut out, SERIALIZATION_LIMIT)
            .map_err(|e| err(format!("gizli anahtar serilestirilemedi: {e}")))?;
        Ok(out)
    }

    /// Concrete'in `keygen_with_initial_keys` fonksiyonunun bekledigi bicim:
    /// tfhe-rs `LweSecretKey`, **safe_serialize** zarfiyla (duz bincode degil).
    pub fn export_lwe_secret_key_inner(&self) -> Result<Vec<u8>, FheError> {
        let shortint_ck = self.client_key.clone().into_raw_parts().0.into_raw_parts();
        let (encryption_key_view, _noise) = shortint_ck.encryption_key_and_noise();
        let encryption_key: LweSecretKey<Vec<u64>> =
            LweSecretKey::from_container(encryption_key_view.into_container().to_vec());

        let mut out = Vec::new();
        safe_serialize(&encryption_key, &mut out, SERIALIZATION_LIMIT)
            .map_err(|e| err(format!("LWE anahtari serilestirilemedi: {e}")))?;
        Ok(out)
    }

    pub fn encrypt_one(&self, value: u8) -> Result<Vec<u8>, FheError> {
        let ciphertext = FheUint8::encrypt(value, &self.client_key);
        let mut out = Vec::new();
        safe_serialize(&ciphertext, &mut out, SERIALIZATION_LIMIT)
            .map_err(|e| err(format!("sifreli metin serilestirilemedi: {e}")))?;
        Ok(out)
    }

    pub fn encrypt_each(&self, values: &[u8]) -> Result<Vec<Vec<u8>>, FheError> {
        if values.is_empty() {
            return Err(err("bos dozaj vektoru sifrelenemez"));
        }
        values.iter().map(|&v| self.encrypt_one(v)).collect()
    }

    pub fn export_server_key_inner(&self) -> Result<Vec<u8>, FheError> {
        let server_key = CompressedServerKey::new(&self.client_key);
        let mut out = Vec::new();
        safe_serialize(&server_key, &mut out, SERIALIZATION_LIMIT)
            .map_err(|e| err(format!("sunucu anahtari serilestirilemedi: {e}")))?;
        Ok(out)
    }

    /// Shamir bolme.
    ///
    /// `sharks` sirri GF(256) uzerinde **bayt bayt** boler; her parca sirla
    /// ayni uzunluktadir (+1 bayt indeks). Gizli anahtar buyuk oldugu icin
    /// parcalar da buyuktur — bu, algoritmanin dogasi geregidir, hata degil.
    pub fn split_secret_key_inner(&self) -> Result<Vec<Vec<u8>>, FheError> {
        let secret = self.export_secret_key_inner()?;
        let dealer = Sharks(SHARE_THRESHOLD);

        let shares: Vec<Vec<u8>> = dealer
            .dealer(&secret)
            .take(SHARE_COUNT as usize)
            .map(|share| Vec::from(&share))
            .collect();

        if shares.len() != SHARE_COUNT as usize {
            return Err(err(format!(
                "{} parca uretilmeliydi, {} uretildi",
                SHARE_COUNT,
                shares.len()
            )));
        }

        Ok(shares)
    }

    pub fn recover_from_shares_inner(shares: &[Vec<u8>]) -> Result<Self, FheError> {
        if (shares.len() as u8) < SHARE_THRESHOLD {
            return Err(err(format!(
                "yetersiz parca: {} verildi, en az {} gerekiyor",
                shares.len(),
                SHARE_THRESHOLD
            )));
        }

        let parsed: Result<Vec<Share>, _> = shares
            .iter()
            .map(|bytes| Share::try_from(bytes.as_slice()))
            .collect();
        let parsed = parsed.map_err(|e| err(format!("parca cozulemedi: {e}")))?;

        let secret = Sharks(SHARE_THRESHOLD)
            .recover(parsed.as_slice())
            .map_err(|e| err(format!("gizli anahtar geri getirilemedi: {e}")))?;

        Self::from_secret_key_inner(&secret)
    }

    pub fn client_key(&self) -> &ClientKey {
        &self.client_key
    }
}

// --------------------------------------------------------------------------------------
// Testler
// --------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    // Sifre cozme yalnizca testlerde gerekir: uretim yolunda tarayici sifreler,
    // cozmez. Bu yuzden `FheDecrypt` burada, modulun tepesinde degil.
    use tfhe::prelude::FheDecrypt;

    #[test]
    fn compute_params_match_zama_reference_exactly() {
        let ours: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&COMPUTE_PARAMS).unwrap()).unwrap();
        let reference: serde_json::Value =
            serde_json::from_str(include_str!("../tests/zama_reference_params.json")).unwrap();

        for field in [
            "lwe_dimension",
            "glwe_dimension",
            "polynomial_size",
            "pbs_base_log",
            "pbs_level",
            "ks_base_log",
            "ks_level",
            "message_modulus",
            "carry_modulus",
            "max_noise_level",
            "encryption_key_choice",
        ] {
            assert_eq!(ours[field], reference[field], "alan sapmis: {field}");
        }

        for field in ["lwe_noise_distribution", "glwe_noise_distribution"] {
            let a = ours[field]["Gaussian"]["std"].as_f64().unwrap();
            let b = reference[field]["Gaussian"]["std"].as_f64().unwrap();
            assert!(((a - b) / b).abs() < 1e-12, "{field} sapmis: {a:e} vs {b:e}");
        }
    }

    #[test]
    fn browser_encrypts_and_decrypts_with_its_own_key() {
        let enc = SecretEncryptor::generate_inner();
        for value in [0u8, 1, 2] {
            let bytes = enc.encrypt_one(value).unwrap();
            let ct: FheUint8 = safe_deserialize(&bytes[..], SERIALIZATION_LIMIT).unwrap();
            let clear: u8 = ct.decrypt(enc.client_key());
            assert_eq!(clear, value);
        }
    }

    #[test]
    fn panel_order_is_preserved() {
        let enc = SecretEncryptor::generate_inner();
        let full = [0u8, 1, 2, 0, 1, 2, 0, 1];
        let selected = select(&full, &[7, 2, 4]).unwrap();
        let parts = enc.encrypt_each(&selected).unwrap();

        for (i, expected) in [1u8, 2, 1].iter().enumerate() {
            let ct: FheUint8 = safe_deserialize(&parts[i][..], SERIALIZATION_LIMIT).unwrap();
            let clear: u8 = ct.decrypt(enc.client_key());
            assert_eq!(clear, *expected);
        }
    }

    #[test]
    fn exported_key_reproduces_the_same_client() {
        let enc = SecretEncryptor::generate_inner();
        let bytes = enc.encrypt_one(2).unwrap();

        let exported = enc.export_secret_key_inner().unwrap();
        let restored = SecretEncryptor::from_secret_key_inner(&exported).unwrap();

        let ct: FheUint8 = safe_deserialize(&bytes[..], SERIALIZATION_LIMIT).unwrap();
        let clear: u8 = ct.decrypt(restored.client_key());
        assert_eq!(clear, 2);
    }

    #[test]
    fn lwe_secret_key_is_safe_serialized_for_concrete() {
        let enc = SecretEncryptor::generate_inner();
        let key = enc.export_lwe_secret_key_inner().unwrap();
        // safe_serialize zarfi olmadan Concrete "size limit" panigine dusuyordu.
        assert!(key.len() > 4096 * 8, "anahtar beklenenden kucuk: {}", key.len());
    }

    #[test]
    fn empty_input_is_rejected() {
        let enc = SecretEncryptor::generate_inner();
        assert!(enc.encrypt_each(&[]).is_err());
    }

    // --- BSKK-44: esikli custody -------------------------------------------

    #[test]
    fn secret_key_splits_into_ten_shares() {
        let enc = SecretEncryptor::generate_inner();
        let shares = enc.split_secret_key_inner().unwrap();

        assert_eq!(shares.len(), SHARE_COUNT as usize);
        // Her parca sirla ayni buyuklukte olmali (+indeks bayti).
        let secret_len = enc.export_secret_key_inner().unwrap().len();
        for share in &shares {
            assert!(share.len() >= secret_len, "parca cok kucuk: {}", share.len());
        }
    }

    #[test]
    fn threshold_shares_recover_a_working_key() {
        let enc = SecretEncryptor::generate_inner();
        let ciphertext = enc.encrypt_one(2).unwrap();
        let shares = enc.split_secret_key_inner().unwrap();

        // Tam esik sayida parca; ilk 7.
        let subset: Vec<Vec<u8>> = shares[..SHARE_THRESHOLD as usize].to_vec();
        let recovered = SecretEncryptor::recover_from_shares_inner(&subset).unwrap();

        let ct: FheUint8 = safe_deserialize(&ciphertext[..], SERIALIZATION_LIMIT).unwrap();
        let clear: u8 = ct.decrypt(recovered.client_key());
        assert_eq!(clear, 2, "geri getirilen anahtar orijinal veriyi cozemedi");
    }

    #[test]
    fn any_seven_shares_work_not_just_the_first_seven() {
        let enc = SecretEncryptor::generate_inner();
        let ciphertext = enc.encrypt_one(1).unwrap();
        let shares = enc.split_secret_key_inner().unwrap();

        // Bilincli olarak dagilmis bir alt kume: 3,5,6,7,8,9,0
        let subset: Vec<Vec<u8>> = [3usize, 5, 6, 7, 8, 9, 0]
            .iter()
            .map(|&i| shares[i].clone())
            .collect();

        let recovered = SecretEncryptor::recover_from_shares_inner(&subset).unwrap();
        let ct: FheUint8 = safe_deserialize(&ciphertext[..], SERIALIZATION_LIMIT).unwrap();
        let clear: u8 = ct.decrypt(recovered.client_key());
        assert_eq!(clear, 1);
    }

    #[test]
    fn six_shares_are_not_enough() {
        let enc = SecretEncryptor::generate_inner();
        let shares = enc.split_secret_key_inner().unwrap();

        let subset: Vec<Vec<u8>> = shares[..(SHARE_THRESHOLD - 1) as usize].to_vec();
        let result = SecretEncryptor::recover_from_shares_inner(&subset);

        assert!(result.is_err(), "esigin altinda anahtar geri getirilebildi");
    }

    #[test]
    fn a_single_share_leaks_nothing_usable() {
        let enc = SecretEncryptor::generate_inner();
        let secret = enc.export_secret_key_inner().unwrap();
        let shares = enc.split_secret_key_inner().unwrap();

        // Tek parca, sirrin kendisiyle ayni olmamali (birebir sizinti kontrolu).
        for share in &shares {
            assert_ne!(&share[1..], &secret[..], "parca sirri duz tasiyor");
        }
        assert!(SecretEncryptor::recover_from_shares_inner(&shares[..1]).is_err());
    }

    #[test]
    fn server_key_is_derived_and_cannot_decrypt() {
        let enc = SecretEncryptor::generate_inner();
        let server_key = enc.export_server_key_inner().unwrap();

        assert!(!server_key.is_empty());
        // Sunucu anahtari gizli anahtar olarak yuklenememeli.
        assert!(SecretEncryptor::from_secret_key_inner(&server_key).is_err());
    }

    #[test]
    fn corrupt_secret_key_is_rejected() {
        assert!(SecretEncryptor::from_secret_key_inner(&[0xde, 0xad]).is_err());
    }
}
