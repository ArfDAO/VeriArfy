//! Tarayicinin yaptigi isin birebir karsiligi: GIZLI ANAHTAR ile sifreleme.
//!
//! stdin : {"values": [0,1,2,...]}
//! cikti : <dir>/lwe_secret_key.bin  + <dir>/ct_<i>.bin
//!
//! Uretimde bu adim tarayicidaki wasm modulunde calisir; burada Python
//! testinin "tarayici" rolunu oynayabilmesi icin ayni kod native cagrilir.
use std::io::Read;

use veriarfy_client_fhe::pubkey::SecretEncryptor;

fn main() {
    let out_dir = std::env::args().nth(1).expect("cikti dizini gerekli");
    std::fs::create_dir_all(&out_dir).unwrap();

    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let request: serde_json::Value = serde_json::from_str(&input).unwrap();
    let values: Vec<u8> = request["values"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u8)
        .collect();

    // Tarayici gizli anahtarini KENDI uretir.
    let encryptor = SecretEncryptor::generate_inner();

    // Concrete devresi bu anahtarla ozdeslestirilecek.
    let lwe = encryptor.export_lwe_secret_key_inner().expect("LWE anahtari");
    std::fs::write(format!("{out_dir}/lwe_secret_key.bin"), &lwe).unwrap();

    let parts = encryptor.encrypt_each(&values).expect("sifreleme");
    for (i, part) in parts.iter().enumerate() {
        std::fs::write(format!("{out_dir}/ct_{i}.bin"), part).unwrap();
    }

    println!(
        "lwe_secret_key {} B | {} sifreli metin, her biri ~{} B",
        lwe.len(),
        parts.len(),
        parts.first().map(|p| p.len()).unwrap_or(0)
    );
}
