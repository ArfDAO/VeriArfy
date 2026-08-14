fn main() {
    use veriarfy_client_fhe::pubkey::{SecretEncryptor, SHARE_COUNT, SHARE_THRESHOLD};
    let enc = SecretEncryptor::generate_inner();
    let sk = enc.export_secret_key_inner().unwrap();
    let lwe = enc.export_lwe_secret_key_inner().unwrap();
    let svk = enc.export_server_key_inner().unwrap();
    let shares = enc.split_secret_key_inner().unwrap();
    let ct = enc.encrypt_one(1).unwrap();
    let mb = |b: usize| format!("{:.2} MB", b as f64 / 1048576.0);
    let kb = |b: usize| format!("{:.1} KB", b as f64 / 1024.0);
    println!("=== BSKK-44 ANAHTAR MALZEMESI ===");
    println!("ClientKey (gizli, tarayicida)   : {}", kb(sk.len()));
    println!("LWE anahtari (Concrete keygen)  : {}", kb(lwe.len()));
    println!("ServerKey (sikistirilmis)       : {}", mb(svk.len()));
    println!("Shamir: {} parca, esik {}", SHARE_COUNT, SHARE_THRESHOLD);
    println!("  parca basina                  : {}", kb(shares[0].len()));
    println!("  toplam dagitilan              : {}", mb(shares.iter().map(|s| s.len()).sum::<usize>()));
    println!("Sifreli dozaj (1 adet)          : {}", kb(ct.len()));
    println!("=================================");
}
