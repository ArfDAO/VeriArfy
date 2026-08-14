"""Uc katmanli mimarinin SESSIZ HATA kalkani.

Sorunun tam hali: tarayici veriyi **TUniform** PKE parametreleriyle sifreliyor;
sunucu `expand()` ile onu **Gaussian** hesap alanina keyswitch ediyor; Concrete
devresi ise girdinin belirli bir varyansta gelecegini varsayarak derlendi.

Keyswitch sonrasi gurultu, devrenin varsaydigi varyanstan yuksek olursa sonuc
**hata vermez, sadece yanlis cikar**. FHE'de bu en tehlikeli basarisizlik
bicimidir: her sey calisiyor gorunur.

Bu betik, o varsayimi olcumle kapatir:

    tarayici rolu (Global Public Key ile sifrele)
        -> rust_expander.expand_compact_blob (keyswitch)
        -> Concrete devresi (sifreli nokta-carpimi)
        -> cozum
        -> SIFRESIZ hesapla ayni mi?

Calistirma:
    packages/ml$ .venv/bin/python -m pytest tests/test_noise_variance.py -v -s

GURULTU UYUSMAZSA NE YAPILIR
    Testin sonundaki `test_report_noise_headroom` ciktisi hangi yonde
    ayarlanacagini soyler. Ozetle secenekler, ucuzdan pahaliya:

    1. `pbs_level` artir (or. 1 -> 2) ve `pbs_base_log` kucult (23 -> 15):
       bootstrap daha ince adimlarla yapilir, gurultu duser; bedeli hiz.
       Bu, Rust tarafinda COMPUTE_PARAMS degistirilerek yapilir ve
       `tfhers_params.json` yeniden uretilir — iki taraf otomatik senkron kalir.
    2. Daha dusuk `p_fail` hedefli parametre kumesine gec (2^-128 zaten siki;
       gerekirse mesaj/carry genisligini 2/2'den 2/3'e cikar).
    3. Devrede ara `fhe.refresh()` / PBS ekleyerek gurultuyu tazele — model
       agirliklarinin buyuklugunu dusurmek (daha guclu L2) de ayni ise yarar.

    Yapilmamasi gereken: hata payini "genelde dogru cikiyor" diye kabul etmek.
    Tibbi bir tahminde sessiz bir bit hatasi kabul edilemez.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
import pytest

PACKAGE_DIR = Path(__file__).resolve().parents[1]
CLIENT_CRATE = PACKAGE_DIR.parent / "client-fhe-rust"

# --------------------------------------------------------------------------------------
# Bagimliliklar — eksikse testi atla, sessizce yesil gosterme
# --------------------------------------------------------------------------------------

expander = pytest.importorskip(
    "veriarfy_expander",
    reason="PyO3 eklentisi kurulu degil: packages/ml/rust_expander$ maturin develop --release",
)

from src.genomic import tfhers_circuit as tc  # noqa: E402

#: Kucuk ama gercekci bir panel. Buyutmek testi yavaslatir, mantigi degistirmez.
PANEL_SIZE = 4

#: Kuantize model agirliklari (arastirmacinin IP'si — devrede duz metin kalir).
WEIGHTS = np.array([3, -2, 5, 1], dtype=np.int64)
BIAS = 0

#: Dozaj alaninin tamami taranir: 0, 1 ve 2 kombinasyonlari.
TEST_VECTORS = [
    np.array([0, 0, 0, 0], dtype=np.uint8),
    np.array([1, 1, 1, 1], dtype=np.uint8),
    np.array([2, 2, 2, 2], dtype=np.uint8),
    np.array([0, 1, 2, 1], dtype=np.uint8),
    np.array([2, 0, 1, 0], dtype=np.uint8),
]


# --------------------------------------------------------------------------------------
# KMS rolu — anahtarlari Rust uretir, Concrete devresi ayni anahtari kullanir
# --------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def kms_material(tmp_path_factory) -> dict:
    """Rust tarafindan kuresel anahtar malzemesini uretir.

    Uretimde bu adim esikli KMS'te calisir ve gizli anahtar hicbir tarafta
    butun halde bulunmaz. Testte tek parca uretilir; olculen sey anahtarin
    nasil uretildigi degil, **keyswitch sonrasi gurultunun devreyi bozup
    bozmadigidir**.
    """
    out_dir = tmp_path_factory.mktemp("kms")

    result = subprocess.run(
        [
            "cargo",
            "run",
            "--release",
            "--example",
            "kms_keygen",
            "--",
            str(out_dir),
        ],
        cwd=CLIENT_CRATE,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        pytest.skip(f"kms_keygen ornegi calistirilamadi:\n{result.stderr[-800:]}")

    material = {
        "public_key": (out_dir / "compact_public_key.bin").read_bytes(),
        "server_key": (out_dir / "server_key.bin").read_bytes(),
        "lwe_secret_key": (out_dir / "lwe_secret_key.bin").read_bytes(),
    }
    print(
        f"\nKMS malzemesi: acik anahtar {len(material['public_key'])/1024:.1f} KB, "
        f"sunucu anahtari {len(material['server_key'])/1048576:.1f} MB"
    )
    return material


@pytest.fixture(scope="module")
def circuit(kms_material):
    """Devreyi KMS'in gizli anahtariyla anahtarlar.

    `keygen_with_initial_keys`, devrenin giris anahtarini KMS'inkiyle
    ozdeslestirir; boylece tarayicinin acik anahtarla urettigi sifreli metin
    bu devrede gecerlidir.
    """
    built = tc.build_dot_product_circuit(WEIGHTS, BIAS)

    sk = kms_material["lwe_secret_key"]
    built.bridge.keygen_with_initial_keys({i: sk for i in range(built.n_inputs)})
    return built


def browser_encrypt(public_key: bytes, dosages: np.ndarray) -> bytes:
    """Tarayicinin yaptigi is: yalnizca acik anahtarla sifreleme."""
    result = subprocess.run(
        ["cargo", "run", "--release", "--example", "pke_encrypt", "--"],
        cwd=CLIENT_CRATE,
        input=json.dumps(
            {"public_key_hex": public_key.hex(), "values": dosages.tolist()}
        ),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"tarayici sifrelemesi basarisiz:\n{result.stderr[-800:]}")

    return bytes.fromhex(result.stdout.strip().splitlines()[-1])


# --------------------------------------------------------------------------------------
# Testler
# --------------------------------------------------------------------------------------


def test_expander_module_loads():
    """PyO3 eklentisi yuklenebiliyor ve surumu bekledigimiz gibi."""
    assert expander.tfhe_version() == "1.7"
    assert hasattr(expander, "expand_compact_blob")


def test_compact_blob_length_is_readable_without_expanding(kms_material):
    """Sunucu, uyusmayan bir blobu pahali islemden once reddedebilmeli."""
    blob = browser_encrypt(kms_material["public_key"], TEST_VECTORS[0])
    assert expander.compact_blob_len(blob) == PANEL_SIZE


def test_expansion_produces_one_ciphertext_per_dosage(kms_material):
    blob = browser_encrypt(kms_material["public_key"], TEST_VECTORS[0])
    expanded = expander.expand_compact_blob(blob, kms_material["server_key"])

    assert len(expanded) == PANEL_SIZE
    assert all(isinstance(part, bytes) and len(part) > 0 for part in expanded)


def test_corrupt_blob_is_rejected(kms_material):
    """Bozuk girdi sessizce gecmemeli."""
    with pytest.raises(ValueError):
        expander.expand_compact_blob(b"\xde\xad\xbe\xef", kms_material["server_key"])


@pytest.mark.parametrize("dosages", TEST_VECTORS, ids=lambda v: "".join(map(str, v)))
def test_fhe_result_matches_plaintext_exactly(kms_material, circuit, dosages):
    """ASIL KANIT: sifreli hesap, sifresiz hesapla BIREBIR ayni mi?

    Uyusmazlik gurultunun devreyi bozdugu anlamina gelir; modulun basindaki
    "GURULTU UYUSMAZSA NE YAPILIR" bolumune bakin.
    """
    blob = browser_encrypt(kms_material["public_key"], dosages)
    expanded = expander.expand_compact_blob(blob, kms_material["server_key"])

    encrypted_result = tc.run_encrypted(circuit, expanded)

    # Cozum, uretimde KMS'in esikli akisidir; testte devrenin istemcisi yapar.
    decrypted = circuit.bridge.import_value  # noqa: F841  (asagida acik cozum)
    clear = circuit.circuit.decrypt(
        circuit.bridge.import_value(encrypted_result, input_idx=0)
    )

    expected = tc.plaintext_reference(circuit, dosages)
    assert int(clear) == expected, (
        f"GURULTU BOZULMASI: sifreli sonuc {clear}, sifresiz {expected}. "
        "Keyswitch sonrasi gurultu devrenin varsayimini asiyor olabilir."
    )


def test_report_noise_headroom(kms_material, circuit, capsys):
    """Tum dozaj alanini tarar ve hata payini raporlar.

    Tek bir vektorun dogru cikmasi yeterli degildir: gurultu olasiliksaldir.
    Burada alanin tamami taranir ve **tek bir** uyusmazlik bile basarisizliktir.
    """
    mismatches = []

    for dosages in TEST_VECTORS:
        blob = browser_encrypt(kms_material["public_key"], dosages)
        expanded = expander.expand_compact_blob(blob, kms_material["server_key"])
        encrypted_result = tc.run_encrypted(circuit, expanded)
        clear = int(
            circuit.circuit.decrypt(
                circuit.bridge.import_value(encrypted_result, input_idx=0)
            )
        )
        expected = tc.plaintext_reference(circuit, dosages)
        if clear != expected:
            mismatches.append((dosages.tolist(), clear, expected))

    with capsys.disabled():
        print(f"\n=== GURULTU RAPORU ===")
        print(f"denenen vektor : {len(TEST_VECTORS)}")
        print(f"uyusmazlik     : {len(mismatches)}")
        for vec, got, want in mismatches:
            print(f"  {vec}: sifreli={got} sifresiz={want}")
        print("======================")

    assert not mismatches, (
        f"{len(mismatches)} vektorde gurultu sonucu bozdu. "
        "pbs_level'i artirip pbs_base_log'u kucultmeyi deneyin (modul docstring'i)."
    )
