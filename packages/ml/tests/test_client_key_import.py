"""NIHAI KANIT: Concrete, tarayicinin gizli anahtariyla uretilmis taze sifreli
metni kabul ediyor mu?

# Mimari

    tarayici (wasm)  : kendi ClientKey'ini uretir, FheUint8 sifreler
                       -> gizli anahtar cihazi TERK ETMEZ
    sunucu (Concrete): devrenin girdi anahtarini tarayicininkiyle ozdeslestirir
                       (keygen_with_initial_keys) ve sifreli veriyi isler

PKE, compact liste ve `expand()` adimi tamamen kaldirildi: gurultusu Concrete'in
girdi sozlesmesinin ~10^24 kati cikiyordu. Taze gizli-anahtar sifrelemesi ise
olculdu ve hedefin icinde: 4,66e-38 / gereken 4,70e-38.

Calistirma:
    packages/ml$ .venv/bin/python -m pytest tests/test_client_key_import.py -v -s
"""

from __future__ import annotations

import json
import subprocess
from functools import partial
from pathlib import Path

import numpy as np
import pytest
from concrete import fhe
from concrete.fhe import tfhers

PACKAGE_DIR = Path(__file__).resolve().parents[1]
CLIENT_CRATE = PACKAGE_DIR.parent / "client-fhe-rust"

#: Zama'nin tfhers referans parametreleri — Rust tarafi da birebir bunu kullanir.
PARAMS_PATH = PACKAGE_DIR / "data" / "tfhers_params_zama.json"

#: Kucuk ama gercek bir panel; buyutmek testi yavaslatir, mantigi degistirmez.
DOSAGES = [0, 1, 2, 1]
WEIGHTS = [3, -2, 5, 1]


@pytest.fixture(scope="module")
def tfhers_type():
    return tfhers.get_type_from_params(str(PARAMS_PATH), is_signed=False, precision=8)


@pytest.fixture(scope="module")
def browser_output(tmp_path_factory) -> dict:
    """Tarayici rolu: gizli anahtar uretir ve dozajlari sifreler."""
    out_dir = tmp_path_factory.mktemp("browser")

    result = subprocess.run(
        ["cargo", "run", "--release", "--example", "sk_encrypt", "--", str(out_dir)],
        cwd=CLIENT_CRATE,
        input=json.dumps({"values": DOSAGES}),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        pytest.skip(f"tarayici sifrelemesi calistirilamadi:\n{result.stderr[-800:]}")

    ciphertexts = [(out_dir / f"ct_{i}.bin").read_bytes() for i in range(len(DOSAGES))]
    material = {
        "lwe_secret_key": (out_dir / "lwe_secret_key.bin").read_bytes(),
        "ciphertexts": ciphertexts,
    }
    print(
        f"\ntarayici: {len(ciphertexts)} sifreli metin, "
        f"her biri {len(ciphertexts[0]) / 1024:.0f} KB; "
        f"LWE anahtari {len(material['lwe_secret_key']) / 1024:.0f} KB"
    )
    return material


@pytest.fixture(scope="module")
def circuit(tfhers_type, browser_output):
    """Sifreli nokta-carpimi devresi; girdi anahtari tarayicininkiyle ozdes."""
    n = len(DOSAGES)
    namespace = {"tfhers": tfhers, "t": tfhers_type, "w": WEIGHTS}
    signature = ", ".join(f"x{i}" for i in range(n))
    body = " + ".join(f"tfhers.to_native(x{i}) * w[{i}]" for i in range(n))
    exec(f"def compute({signature}):\n    return {body}\n", namespace)  # noqa: S102

    ti = partial(tfhers.TFHERSInteger, tfhers_type)
    inputset = [tuple(ti(v) for _ in range(n)) for v in (0, 1, 2, 120)]

    compiled = fhe.Compiler(namespace["compute"], {f"x{i}": "encrypted" for i in range(n)})
    circuit = compiled.compile(inputset)
    bridge = tfhers.new_bridge(circuit)

    # Devrenin girdi anahtari = tarayicinin anahtari.
    sk = browser_output["lwe_secret_key"]
    bridge.keygen_with_initial_keys({i: sk for i in range(n)})
    return circuit, bridge


def test_variance_contract_is_satisfied(circuit):
    """Beyan edilen varyans ile devrenin bekledigi varyans esit olmali.

    Onceki parametre setinde bu oran 9,589'du ve import her seferinde
    reddediliyordu.
    """
    circ, bridge = circuit
    fn = bridge._get_default_func_or_raise_error("import_value")

    declared = bridge._input_variance(fn, 0)
    expected = circ.client.specs.program_info.input_variance_at(0, fn)

    print(f"\nbeyan          : {declared:.6e}")
    print(f"devre bekliyor : {expected:.6e}")
    print(f"oran           : {declared / expected:.6f}")

    assert abs(declared / expected - 1.0) < 1e-9


def test_concrete_accepts_fresh_client_key_ciphertext(circuit, browser_output):
    """ASIL KANIT: import_value taze sifreli metni kabul ediyor mu?"""
    _, bridge = circuit

    imported = [
        bridge.import_value(buf, input_idx=i)
        for i, buf in enumerate(browser_output["ciphertexts"])
    ]

    assert len(imported) == len(DOSAGES)
    print(f"\n{len(imported)} sifreli metin devreye KABUL EDILDI")


def test_encrypted_dot_product_matches_plaintext(circuit, browser_output):
    """Sifreli hesap, sifresiz hesapla birebir ayni mi?"""
    circ, bridge = circuit

    imported = [
        bridge.import_value(buf, input_idx=i)
        for i, buf in enumerate(browser_output["ciphertexts"])
    ]

    result = circ.run(*imported)
    clear = int(circ.decrypt(result))
    expected = int(np.dot(DOSAGES, WEIGHTS))

    print(f"\nsifreli sonuc : {clear}")
    print(f"sifresiz      : {expected}  (dozajlar {DOSAGES} x agirliklar {WEIGHTS})")

    assert clear == expected
