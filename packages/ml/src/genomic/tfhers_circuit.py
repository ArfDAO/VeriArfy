"""VeriArfy — tfhe-rs girdili Concrete devresi (uc katmanli mimarinin sunucu ucu).

Bu modul, Concrete ML'in kendi dagitim hattinin yerine gecer. Sebep: standart
`FHEModelDev`/`FHEModelServer` hatti, istemcinin **kendi** anahtarini uretmesini
ve 101 MB'lik degerlendirme anahtarini kendisinin olusturmasini gerektiriyordu.
Burada ise akis su:

    tarayici (Global Public Key, TUniform PKE)
        -> compact ciphertext (~79 KB / 1000 dozaj)
    sunucu (rust_expander, ServerKey)
        -> keyswitch: PKE alani -> HESAP alani (Gaussian)
    sunucu (bu modul, Concrete devresi)
        -> sifreli nokta-carpimi
        -> tfhe-rs uyumlu sifreli sonuc

Devre **N ayri skaler girdiyle** derlenir (`x0..xN-1`), tek bir vektor girdiyle
degil. Sebep pratik: Concrete'in `import_value` fonksiyonu tek bir tfhe-rs
tamsayisi alir; boylece dizi serilestirme bicimine dair varsayim yapmayiz.

Parametreler elle yazilmaz: Rust tarafi (`computeParamsJson`) tek dogru
kaynaktir ve `data/tfhers_params.json` oradan uretilir.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from concrete import fhe
from concrete.fhe import tfhers

logger = logging.getLogger("veriarfy.genomic.tfhers")

PACKAGE_DIR = Path(__file__).resolve().parents[2]
#: Devre, Rust'tan gelen HAM parametrelerle derlenir.
#:
#: `tfhers_params_adjusted.json` da uretilir ama ARTIK KULLANILMIYOR: girdi
#: gurultusunu yukseltip bootstrap butcesini artirma stratejisi olcumle
#: curutuldu (bkz. adjust_params.py basligi). Concrete'in bekledigi girdi
#: varyansini tfhers tipi degil, **optimizer** belirliyor; pbs_level'i
#: artirmak beklentiyi gevsetmek yerine SIKILASTIRDI (8.10e-30 -> 8.44e-31).
PARAMS_PATH = PACKAGE_DIR / "data" / "tfhers_params.json"

#: Dozaj alani 0..2 oldugu icin 8 bit fazlasiyla yeter; Concrete tipi de
#: tarayicinin urettigi FheUint8 ile ayni genislikte olmali.
PRECISION = 8


class CircuitError(RuntimeError):
    """Devre kurulum/calistirma hatasi."""


def load_tfhers_type(params_path: Path | None = None) -> tfhers.TFHERSIntegerType:
    """Rust'tan uretilmis parametrelerle tfhe-rs tipini kurar.

    Concrete'in `get_type_from_params_dict` fonksiyonu su alanlari zorunlu
    kilar ve karsilanmazsa **sessizce degil, hata vererek** durur:
      - `lwe_noise_distribution.Gaussian.std`  (TUniform ile KeyError)
      - `glwe_dimension == 1`
      - `encryption_key_choice == "Big"`
    """
    path = Path(params_path or PARAMS_PATH)
    if not path.exists():
        raise CircuitError(
            f"parametre dosyasi yok: {path}. Rust tarafindan uretin: "
            "cargo test --release --test params_dump -- --nocapture"
        )

    try:
        return tfhers.get_type_from_params(str(path), is_signed=False, precision=PRECISION)
    except KeyError as exc:
        raise CircuitError(
            f"parametrelerde {exc} alani yok. En olasi sebep: TUniform gurultulu bir "
            "parametre kumesi verilmis. Concrete Gaussian ister; Rust tarafinda "
            "PARAM_MESSAGE_2_CARRY_2_KS_PBS_GAUSSIAN_2M128 kullanin."
        ) from exc


@dataclass
class DotProductCircuit:
    """Sifreli nokta-carpimi devresi ve tfhe-rs koprusu."""

    circuit: fhe.Circuit
    bridge: object
    weights: np.ndarray
    bias: int
    tfhers_type: tfhers.TFHERSIntegerType

    @property
    def n_inputs(self) -> int:
        return int(self.weights.size)


def build_dot_product_circuit(
    weights: np.ndarray,
    bias: int = 0,
    params_path: Path | None = None,
) -> DotProductCircuit:
    """Kuantize lojistik regresyonu tfhe-rs girdili bir devreye cevirir.

    `weights` ve `bias`, egitilmis modelin **kuantize** katsayilaridir; devrenin
    icinde duz metin olarak kalirlar — yani arastirmacinin IP'si sunucuda,
    istemciye hicbir zaman inmez.
    """
    tfhers_type = load_tfhers_type(params_path)
    weights = np.asarray(weights, dtype=np.int64).ravel()

    if weights.size == 0:
        raise CircuitError("agirlik vektoru bos")

    n = int(weights.size)

    # Concrete girdileri ADLARIYLA eslestirir; `*args` kabul etmez
    # ("Encryption status of parameter 'xs' ... is not provided"). Bu yuzden
    # dogru arite ve isimlerle bir fonksiyon uretiyoruz. Govde sabit; degisen
    # tek sey imza.
    namespace: dict = {"tfhers": tfhers, "fhe": fhe, "weights": weights, "bias": int(bias)}
    signature = ", ".join(f"x{i}" for i in range(n))
    body = " + ".join(f"tfhers.to_native(x{i}) * int(weights[{i}])" for i in range(n))
    exec(  # noqa: S102 — imza dinamik, govde sabit ve kullanici girdisi icermez
        f"def inference({signature}):\n    return ({body}) + bias\n",
        namespace,
    )
    inference = namespace["inference"]

    compiler = fhe.Compiler(inference, {f"x{i}": "encrypted" for i in range(n)})

    # Girdi kumesi dozaj alanini (0,1,2) kapsamali ki Concrete bit genisligini
    # dogru hesaplasin.
    inputset = [
        tuple(tfhers.TFHERSInteger(tfhers_type, np.int64(v)) for _ in range(n))
        for v in (0, 1, 2)
    ]

    logger.info("tfhers devresi derleniyor (%d girdi)...", n)
    circuit = compiler.compile(inputset)
    bridge = tfhers.new_bridge(circuit)
    logger.info("devre hazir")

    return DotProductCircuit(
        circuit=circuit,
        bridge=bridge,
        weights=weights,
        bias=int(bias),
        tfhers_type=tfhers_type,
    )


def run_encrypted(circuit: DotProductCircuit, expanded: list[bytes]) -> bytes:
    """Genisletilmis tfhe-rs sifreli metinleri devreden gecirir.

    `expanded`, `rust_expander.expand_compact_blob(...)` ciktisidir: her eleman
    acilmis bir `FheUint8`'in serilestirilmis halidir.

    Doner: tfhe-rs uyumlu, **sifreli** sonuc baytlari.
    """
    if len(expanded) != circuit.n_inputs:
        raise CircuitError(
            f"devre {circuit.n_inputs} girdi bekliyor, {len(expanded)} geldi. "
            "Istemcinin paneli sunucunun paneliyle ayni olmayabilir."
        )

    try:
        imported = [
            circuit.bridge.import_value(buf, input_idx=i) for i, buf in enumerate(expanded)
        ]
    except Exception as exc:  # noqa: BLE001
        raise CircuitError(
            f"tfhe-rs sifreli metni devreye alinamadi: {exc}. Olasi sebepler: "
            "istemci ile sunucu farkli parametrelerle calisiyor ya da farkli "
            "tfhe-rs surumleri kullaniyor."
        ) from exc

    result = circuit.circuit.run(*imported)
    return circuit.bridge.export_value(result, output_idx=0)


def keygen(circuit: DotProductCircuit) -> None:
    """Devrenin anahtar kumesini uretir (KMS'in yaptigi isin yerel karsiligi)."""
    circuit.circuit.keygen()


def input_secret_key(circuit: DotProductCircuit, input_idx: int = 0) -> bytes:
    """Devrenin giris gizli anahtarini disa verir.

    Uretimde bu **yalnizca KMS'te** olur; burada testin tarayici rolunu
    oynayabilmesi icin gerekli.
    """
    return circuit.bridge.serialize_input_secret_key(input_idx=input_idx)


def plaintext_reference(circuit: DotProductCircuit, dosages: np.ndarray) -> int:
    """Ayni hesabin sifresiz karsiligi — FHE sonucunu dogrulamak icin."""
    values = np.asarray(dosages, dtype=np.int64).ravel()
    return int(np.dot(values, circuit.weights) + circuit.bias)
