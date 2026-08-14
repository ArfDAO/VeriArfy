"""Devreye girdi gurultusunu bildirme denemesi — SONUC: BU YOL CALISMIYOR.

# Olcum sonucu (2 yapilandirma)

    pbs_level=1, base_log=23  ->  devrenin bekledigi girdi varyansi 8.0955e-30
    pbs_level=2, base_log=15  ->  devrenin bekledigi girdi varyansi 8.4423e-31

Yani bootstrap butcesini artirmak, devrenin girdiden bekledigi temizligi
GEVSETMEDI, tam tersine ~10 kat SIKILASTIRDI. Beyan ettigimiz 1.26e-11 ile
arada 20 buyukluk mertebesi fark kaldi ve import reddedilmeye devam etti.

Sebep: tfhers tipine yazdigimiz gurultu, devrenin girdi varyansini
BELIRLEMIYOR; onu Concrete'in optimizer'i kendi cozumune gore seciyor.
Dolayisiyla "devreye gercegi bildir" fikri bu API ile uygulanabilir degil.

Modul, olcumun tekrar uretilebilmesi icin duruyor; uretimde kullanilmiyor.

---

Orijinal aciklama:

# Sorun

Tarayici veriyi PKE alaninda sifreler; sunucu `expand()` ile hesap alanina
keyswitch eder. Ortaya cikan sifreli metnin gurultusu, **taze** bir Big-anahtar
sifrelemesinden kacinilmaz olarak yuksektir. Concrete ise devreyi taze
sifreleme varsayimiyla derledigi icin ithal edilen degeri reddeder:

    RuntimeError: Tried to transform a transport value with incompatible variance.

# Cozum

Devreye yalan soylemek yerine **gercegi** bildiriyoruz: girdi gurultusunu
keyswitch sonrasi beklenen seviyeye cekiyor, karsiliginda da bootstrap
butcesini artiriyoruz.

# Neyin degistigi — ve neyin ASLA degismedigi

Degisenler (yalnizca gurultu modeli ve bootstrap butcesi):
  * `glwe_noise_distribution.std` : taze sifreleme gurultusu -> keyswitch sonrasi
  * `pbs_level`      1 -> 2   (daha cok, daha ince adim)
  * `pbs_base_log`  23 -> 15  (her adim daha kucuk)

DEGISMEYENLER (yapisal parametreler): `lwe_dimension`, `glwe_dimension`,
`polynomial_size`, `message_modulus`, `carry_modulus`, `ciphertext_modulus`,
`encryption_key_choice`. Bunlar sifreli metnin **bicimini** belirler; Rust
tarafiyla birebir ayni kalmalidir, yoksa ithal edilen deger yapisal olarak
okunamaz. Bu yuzden bu betik onlara dokunmaz ve dokunulmadigini dogrular.
"""

from __future__ import annotations

import json
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parents[2]
SOURCE = PACKAGE_DIR / "data" / "tfhers_params.json"
TARGET = PACKAGE_DIR / "data" / "tfhers_params_adjusted.json"

#: Yapisal alanlar — degistirilmeleri yasak.
STRUCTURAL = (
    "lwe_dimension",
    "glwe_dimension",
    "polynomial_size",
    "message_modulus",
    "carry_modulus",
    "ciphertext_modulus",
    "encryption_key_choice",
)

PBS_LEVEL = 2
PBS_BASE_LOG = 15


def build_adjusted(source: Path = SOURCE, target: Path = TARGET) -> dict:
    original = json.loads(source.read_text())
    adjusted = json.loads(source.read_text())

    # Keyswitch sonrasi gurultu, kucuk anahtarin taze sifreleme gurultusuna
    # yakindir; olculen degerler bunu isaret ediyor (8.1e-30 beklenen,
    # 1.26e-11 lwe tarafinda). Girdi gurultusunu oraya cekiyoruz.
    keyswitch_std = original["lwe_noise_distribution"]["Gaussian"]["std"]
    adjusted["glwe_noise_distribution"]["Gaussian"]["std"] = keyswitch_std

    adjusted["pbs_level"] = PBS_LEVEL
    adjusted["pbs_base_log"] = PBS_BASE_LOG

    for field in STRUCTURAL:
        if adjusted[field] != original[field]:
            raise RuntimeError(f"yapisal alan degistirilmis: {field}")

    target.write_text(json.dumps(adjusted, indent=2) + "\n")
    return adjusted


if __name__ == "__main__":
    result = build_adjusted()
    print(f"yazildi: {TARGET}")
    print(f"  glwe std   : {result['glwe_noise_distribution']['Gaussian']['std']:.6e}")
    print(f"  pbs_level  : {result['pbs_level']}")
    print(f"  pbs_base_log: {result['pbs_base_log']}")
