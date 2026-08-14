//! Concrete'in tfhers girdi sozlesmesi — mimari kararin kilidi.
//!
//! # Bu dosya neden var
//!
//! Proje boyunca en pahali soru suydu: kullanicilar verilerini **tek bir
//! kolektif acik anahtarla** mi (PKE) yoksa **kendi gizli anahtarlariyla** mi
//! sifreleyecek? Teknik rapor birincisini tarif ediyor; kod ikincisini yapiyor.
//!
//! Bu dosya soruyu bir daha acilmayacak sekilde kapatir. Cevap bir tercih ya da
//! bir olcum sansi degil, bir **kimliktir**:
//!
//! ```text
//!   Concrete'in devre girdisinden talep ettigi varyans
//!     = COMPUTE_PARAMS.glwe_noise.std^2
//!     = TAZE sifrelemenin gurultusu
//! ```
//!
//! Yani sozlesme "su temizlikte olsun" demiyor; **"hic dokunulmamis olsun"**
//! diyor. Pay birakilmamis. Bunun uc dogrudan sonucu var:
//!
//! 1. Sifreli metin uzerinde yapilan **her** islem (toplama, keyswitch, PBS)
//!    gurultuyu artirir ve girdiyi gecersiz kilar.
//! 2. PKE yolu tanim geregi bir keyswitch icerir (`expand()`), dolayisiyla
//!    **hicbir parametre secimiyle** bu sozlesmeye giremez. Daha once bunu
//!    Concrete'in kusuru sanmistik; degil — koprunun girdi tanimi bu.
//! 3. "Bootstrap ile temizleriz" de calismaz; PBS'in cikti gurultusu de taze
//!    sifrelemeden yuksektir. Test 4 bunu olcerek gosterir.
//!
//! Zama'nin kendi tfhers ornegi de zaten gizli anahtarla sifreler
//! (`tfhers_bridge.serialize_input_secret_key` -> Rust tarafinda sifreleme);
//! yani bu, koprunun tasarlandigi kullanim bicimidir.
//!
//! # Mimariye etkisi
//!
//! Concrete ML yolu yapisal olarak **tek kullanicilik** bir cikarim motorudur.
//! Coklu kullanici toplamasi bu yolda cozulemez:
//!   - ortak acik anahtar -> gurultu (bu dosya),
//!   - ortak gizli anahtar -> herkes herkesin verisini cozer (mahremiyet).
//!
//! Populasyon istatistigi bu yuzden **fhEVM** tarafina aittir; orada aginin
//! kendi global anahtari vardir ve farkli adreslerin sifreli metinleri
//! gercekten toplanabilir (bkz. `packages/contracts` testleri).
//!
//! Calistirma:
//!     packages/client-fhe-rust$ cargo test --release --test input_contract -- --nocapture

use tfhe::core_crypto::prelude::decrypt_lwe_ciphertext;
use tfhe::integer::IntegerCiphertext;
use tfhe::prelude::FheEncrypt;
use tfhe::shortint::parameters::DynamicDistribution;
use tfhe::{ClientKey, FheUint8};

use veriarfy_client_fhe::pubkey::{COMPUTE_PARAMS, config};

/// Concrete'in `import_value` sirasinda girdiye ilistirdigi ve devrenin
/// bekledigi varyans.
///
/// Olculdu (`packages/ml/tests/test_client_key_import.py`): beyan edilen ve
/// beklenen deger birebir ayni, oran `1.000000`.
const CONCRETE_REQUIRED_INPUT_VARIANCE: f64 = 4.701977e-38;

/// Varyans tahmini icin ornek sayisi. Her `FheUint8` 4 blok verdigi icin
/// gercek ornek sayisi bunun 4 katidir.
const SAMPLES: usize = 32;

/// Bir LWE sifreli metnin gurultusunu torus biriminde dondurur.
///
/// Gurultu dogrudan gozlenemez; gizli anahtar elimizdeyken hesaplanir:
///
/// ```text
///   faz     = <a, s> + b        (LWE cozumu: mesaj + gurultu)
///   gurultu = faz - mesaj * delta
/// ```
///
/// # PADDING BIT — bu satir bir kez yanlis yazildi
///
/// TFHE shortint'te duz metin alani `2 * message_modulus * carry_modulus`
/// genisligindedir; bastaki bit padding'dir. Delta'yi `2^64 / 16` alip
/// padding'i atlamak, m=1 olan her blokta tam olarak -1/32'lik **sabit** bir
/// sapma uretir ve varyansi 1,8e-4 gibi imkansiz bir degere sisirir. Hata,
/// ayni kodu taze sifrelemeye uygulayan bir kontrol deneyiyle yakalandi:
/// kontrol de ayni sacma degeri verince sorunun olcumde oldugu anlasildi.
fn block_noise(
    secret_key: &tfhe::core_crypto::prelude::LweSecretKeyOwned<u64>,
    ciphertext: &tfhe::core_crypto::prelude::LweCiphertextOwned<u64>,
    expected_message: u64,
) -> f64 {
    let message_modulus = COMPUTE_PARAMS.message_modulus.0 as u128;
    let carry_modulus = COMPUTE_PARAMS.carry_modulus.0 as u128;

    let phase = decrypt_lwe_ciphertext(secret_key, ciphertext).0;

    let delta = (1u128 << 64) / (2 * message_modulus * carry_modulus);
    let ideal = (expected_message as u128).wrapping_mul(delta) as u64;

    // Sapma modulo 2^64 daireseldir; isaretli okumak dogru mesafeyi verir.
    let deviation = phase.wrapping_sub(ideal) as i64;
    deviation as f64 / 2f64.powi(64)
}

/// Ornek gurultulerden duzeltilmis varyans.
fn variance(samples: &[f64]) -> f64 {
    let n = samples.len() as f64;
    let mean = samples.iter().sum::<f64>() / n;
    samples.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1.0)
}

/// Olcum icin gereken malzeme: ust duzey anahtar, shortint anahtari ve
/// sifrelemenin gercekten kullandigi LWE gizli anahtari.
struct Bench {
    client_key: ClientKey,
    shortint_key: tfhe::shortint::ClientKey,
    lwe_secret_key: tfhe::core_crypto::prelude::LweSecretKeyOwned<u64>,
}

fn bench() -> Bench {
    let client_key = ClientKey::generate(config());
    let shortint_key = client_key.clone().into_raw_parts().0.into_raw_parts();

    // `encryption_key_and_noise()` sifrelemenin FIILEN kullandigi anahtari
    // verir. Parametrelerde `encryption_key_choice: Big` oldugu icin bu, GLWE
    // anahtarindan turetilen buyuk anahtardir — kucuk LWE anahtari degil.
    let (encryption_key_view, _noise) = shortint_key.encryption_key_and_noise();
    let lwe_secret_key = tfhe::core_crypto::prelude::LweSecretKey::from_container(
        encryption_key_view.into_container().to_vec(),
    );

    Bench {
        client_key,
        shortint_key,
        lwe_secret_key,
    }
}

// ------------------------------------------------------------------------------------------
// 1. Analitik kimlik — sozlesme, taze sifreleme gurultusunun TA KENDISI
// ------------------------------------------------------------------------------------------

#[test]
fn contract_is_exactly_the_fresh_encryption_noise() {
    let std_dev = match COMPUTE_PARAMS.glwe_noise_distribution {
        DynamicDistribution::Gaussian(g) => g.standard_dev().0,
        other => panic!("beklenmeyen gurultu dagilimi: {other:?}"),
    };

    let analytic = std_dev * std_dev;
    let ratio = analytic / CONCRETE_REQUIRED_INPUT_VARIANCE;

    println!("\n=== SOZLESME KIMLIGI ===");
    println!("glwe standart sapma      : {std_dev:.6e}");
    println!("karesi (varyans)         : {analytic:.6e}");
    println!("Concrete'in talep ettigi : {CONCRETE_REQUIRED_INPUT_VARIANCE:.6e}");
    println!("oran                     : {ratio:.9}");
    println!("========================");

    // Sabit yalnizca 7 anlamli haneyle yazildigi icin tolerans oradan gelir.
    assert!(
        (ratio - 1.0).abs() < 1e-6,
        "sozlesme artik taze sifreleme gurultusune esit degil (oran {ratio}) — \
         COMPUTE_PARAMS degistiyse mimari karar yeniden degerlendirilmelidir"
    );
}

// ------------------------------------------------------------------------------------------
// 2. Deneysel dogrulama — taze sifreleme sozlesmenin uzerine oturuyor
// ------------------------------------------------------------------------------------------

#[test]
fn fresh_secret_key_encryption_lands_on_the_contract() {
    let b = bench();
    let value: u8 = 1;

    let mut noises = Vec::new();
    for _ in 0..SAMPLES {
        let ciphertext = FheUint8::encrypt(value, &b.client_key);
        let (radix, _id, _tag) = ciphertext.into_raw_parts();

        for (index, block) in radix.blocks().iter().enumerate() {
            // FheUint8 = 4 blok x 2 bit; blok i, degerin [2i, 2i+2) bitlerini tutar.
            let expected = ((value as u64) >> (2 * index)) & 0b11;
            noises.push(block_noise(&b.lwe_secret_key, &block.ct, expected));
        }
    }

    let measured = variance(&noises);
    let ratio = measured / CONCRETE_REQUIRED_INPUT_VARIANCE;

    println!("\n=== TAZE SIFRELEME (tarayicinin urettigi) ===");
    println!("ornek sayisi   : {}", noises.len());
    println!("olculen varyans: {measured:.6e}");
    println!("sozlesme       : {CONCRETE_REQUIRED_INPUT_VARIANCE:.6e}");
    println!("oran           : {ratio:.3}");
    println!("=============================================");

    // Sonlu ornekten gelen sacilma icin genis ama anlamli bir bant.
    assert!(
        (0.4..2.5).contains(&ratio),
        "taze sifreleme gurultusu sozlesmeden koptu (oran {ratio:.3})"
    );
}

// ------------------------------------------------------------------------------------------
// 3. Yapisal kanit — TEK bir toplama bile sozlesmeyi asiyor
// ------------------------------------------------------------------------------------------

#[test]
fn a_single_addition_already_exceeds_the_contract() {
    let b = bench();
    let server_key = tfhe::shortint::ServerKey::new(&b.shortint_key);

    let mut fresh = Vec::new();
    let mut summed = Vec::new();

    for _ in 0..(SAMPLES * 4) {
        let a = b.shortint_key.encrypt(1);
        let c = b.shortint_key.encrypt(1);

        fresh.push(block_noise(&b.lwe_secret_key, &a.ct, 1));

        // Saf dogrusal toplama: PBS yok, yalnizca iki LWE vektorunun toplami.
        // Bagimsiz gurultuler toplandigi icin varyans da toplanir -> ~2x.
        let sum = server_key.unchecked_add(&a, &c);
        summed.push(block_noise(&b.lwe_secret_key, &sum.ct, 2));
    }

    let fresh_var = variance(&fresh);
    let sum_var = variance(&summed);

    println!("\n=== SIFIR PAY VAR MI? ===");
    println!("taze varyans            : {fresh_var:.6e}");
    println!("tek toplamadan sonra    : {sum_var:.6e}");
    println!("buyume carpani          : {:.2}x", sum_var / fresh_var);
    println!(
        "sozlesmeye oran         : {:.2}x",
        sum_var / CONCRETE_REQUIRED_INPUT_VARIANCE
    );
    println!("=========================");

    assert!(
        sum_var > CONCRETE_REQUIRED_INPUT_VARIANCE,
        "tek toplama sozlesmeyi asmiyor — sozlesmede pay var demektir, \
         bu durumda PKE karari yeniden incelenmelidir"
    );
}

// ------------------------------------------------------------------------------------------
// 4. "Bootstrap ile temizleriz" fikri de kapaniyor
// ------------------------------------------------------------------------------------------

#[test]
fn bootstrapping_does_not_rescue_a_dirty_ciphertext() {
    let b = bench();
    let server_key = tfhe::shortint::ServerKey::new(&b.shortint_key);

    let mut refreshed = Vec::new();
    for _ in 0..(SAMPLES * 4) {
        let a = b.shortint_key.encrypt(1);

        // `message_extract` bir PBS'tir: gurultuyu "tazeler" ama kendi cikti
        // gurultusu vardir ve bu, taze sifrelemeninkinden yuksektir.
        let out = server_key.message_extract(&a);
        refreshed.push(block_noise(&b.lwe_secret_key, &out.ct, 1));
    }

    let refreshed_var = variance(&refreshed);
    let ratio = refreshed_var / CONCRETE_REQUIRED_INPUT_VARIANCE;

    println!("\n=== PBS SONRASI ===");
    println!("bootstrap cikti varyansi: {refreshed_var:.6e}");
    println!("sozlesme                : {CONCRETE_REQUIRED_INPUT_VARIANCE:.6e}");
    println!("oran                    : {ratio:.3e}");
    println!("===================");

    assert!(
        refreshed_var > CONCRETE_REQUIRED_INPUT_VARIANCE,
        "PBS ciktisi sozlesmenin altinda kaldi — bu dogruysa PKE + bootstrap \
         yolu yeniden degerlendirilmelidir (oran {ratio:.3e})"
    );
}
