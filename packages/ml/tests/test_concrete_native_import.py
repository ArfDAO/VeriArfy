"""NIHAI IZOLASYON: sorun bizim Rust ucumuzda mi, koprude mi?

# Soru

Olculdu: Concrete'in devre girdisinden bekledigi varyans (8,44e-31), tfhe-rs'in
KENDI taze sifrelemesinden (7,86e-30) bile ~9,3 kat daha temiz. Yani hicbir
tfhe-rs sifreli metni bu butceye sigmiyor — PKE'li de, PKE'siz de.

Bu, iki cok farkli anlama gelebilir:

  A) Bizim urettigimiz baytlarda bir sey eksik/fazla (metadata, normalizasyon).
     -> Concrete kendi urettigi tfhers metnini kabul EDER.
  B) 0.10 koprusunde yapisal bir bozukluk var.
     -> Concrete kendi urettigi metni bile REDDEDER.

# Yontem — neden iki devre

`tfhers` girdisi Concrete'in kendi istemcisiyle dogrudan sifrelenemez; girdinin
tanimi geregi disaridan (tfhe-rs'ten) gelmesi beklenir. Bu yuzden Concrete'e
once bir tfhers metni **URETTIRIYORUZ**:

    MINT  : native girdi -> tfhers cikti     (export_value ile bayt aliriz)
    TUKET : tfhers girdi -> native cikti     (import_value ile geri veririz)

Ikisi ayni anahtari paylasmalidir; bunun icin MINT'in anahtari disa alinip
TUKET'e enjekte edilir. Bu round-trip tamamen Concrete'in kendi icinde kalir:
tfhe-rs hic devrede degildir.

Calistirma:
    packages/ml$ .venv/bin/python -m pytest tests/test_concrete_native_import.py -v -s
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from concrete import fhe
from concrete.fhe import tfhers

from src.genomic.tfhers_circuit import PARAMS_PATH, PRECISION, load_tfhers_type

WEIGHT = 3


@pytest.fixture(scope="module")
def tfhers_type():
    return load_tfhers_type(PARAMS_PATH)


@pytest.fixture(scope="module")
def mint(tfhers_type):
    """native girdi -> tfhers cikti. Concrete'e gecerli bir tfhers metni urettirir."""

    def to_tfhers(x):
        return tfhers.from_native(x * WEIGHT, tfhers_type)

    compiler = fhe.Compiler(to_tfhers, {"x": "encrypted"})
    circuit = compiler.compile([np.int64(v) for v in (0, 1, 2, 3)])
    return circuit, tfhers.new_bridge(circuit)


@pytest.fixture(scope="module")
def consume(tfhers_type):
    """tfhers girdi -> native cikti. Uretilen metni geri almaya calisir."""

    def from_tfhers(x):
        return tfhers.to_native(x) + 0

    compiler = fhe.Compiler(from_tfhers, {"x": "encrypted"})
    inputset = [tfhers.TFHERSInteger(tfhers_type, np.int64(v)) for v in (0, 1, 2, 3)]
    circuit = compiler.compile(inputset)
    return circuit, tfhers.new_bridge(circuit)


def test_mint_produces_a_tfhers_ciphertext(mint):
    """Concrete kendi icinden tfhers formatinda bir sifreli metin uretebiliyor mu?"""
    circuit, bridge = mint
    circuit.keygen()

    encrypted_input = circuit.encrypt(np.int64(2))
    result = circuit.run(encrypted_input)
    exported = bridge.export_value(result, output_idx=0)

    assert isinstance(exported, bytes) and len(exported) > 0
    print(f"\nConcrete'in urettigi tfhers metni: {len(exported)} bayt")


def test_concrete_can_reimport_its_own_ciphertext(mint, consume):
    """ASIL SORU: Concrete kendi urettigi tfhers metnini geri alabiliyor mu?

    Basarili -> sorun bizim Rust baytlarimizda (Senaryo A).
    Basarisiz -> koprude yapisal bozukluk (Senaryo B).
    """
    mint_circuit, mint_bridge = mint
    consume_circuit, consume_bridge = consume

    mint_circuit.keygen()

    # Iki devre ayni anahtari kullanmali; MINT'in anahtarini TUKET'e enjekte et.
    try:
        shared_key = mint_bridge.serialize_input_secret_key(input_idx=0)
        print(f"\nMINT'in giris anahtari disa alindi: {len(shared_key)} bayt")
        consume_bridge.keygen_with_initial_keys({0: shared_key})
        key_shared = True
    except Exception as exc:  # noqa: BLE001
        print(f"\nanahtar paylasilamadi ({exc}); TUKET kendi anahtarini uretiyor")
        consume_circuit.keygen()
        key_shared = False

    value = np.int64(2)
    encrypted_input = mint_circuit.encrypt(value)
    minted = mint_bridge.export_value(mint_circuit.run(encrypted_input), output_idx=0)

    print(f"MINT ciktisi: {len(minted)} bayt (deger {int(value)} x {WEIGHT})")
    print(f"anahtar paylasildi mi: {key_shared}")

    # --- Kritik cagri ---
    imported = consume_bridge.import_value(minted, input_idx=0)
    result = consume_circuit.run(imported)
    clear = consume_circuit.decrypt(result)

    print(f"TUKET cozumu: {int(clear)} (beklenen {int(value) * WEIGHT})")
    assert int(clear) == int(value) * WEIGHT


def test_report_variance_expectations(mint, consume):
    """Iki devrenin varyans beyanlarini yan yana koyar.

    Kok neden birim/normalizasyon farkiysa, MINT'in cikti varyansi ile
    TUKET'in girdi varyansi arasinda sistematik bir oran gorunmelidir.
    """
    _, mint_bridge = mint
    consume_circuit, consume_bridge = consume

    consume_fn = consume_bridge._get_default_func_or_raise_error("import_value")
    declared = consume_bridge._input_variance(consume_fn, 0)

    info = consume_circuit.client.specs.program_info
    expected = info.input_variance_at(0, consume_fn)

    with_ratio = declared / expected if expected else float("nan")
    print("\n=== VARYANS BEYANLARI ===")
    print(f"tfhers tipinin beyani (import_value'nun kullandigi): {declared:.6e}")
    print(f"devrenin bekledigi (program_info)                  : {expected:.6e}")
    print(f"oran                                               : {with_ratio:.3f}")
    print("=========================")
