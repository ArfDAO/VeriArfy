"""
Panel tavaninin KESIN teshisi — 16 SNP sinirinin sebebi nedir?

`model.py` su ana kadar sunu kaydediyordu: panel >= 20'de Concrete'in LLVM
arka ucu cokuyor, cokme surec olumu oldugu icin yakalanamiyor ve `n_bits`,
duzenlilestirme, derleme kumesi boyutu degisikliklerinden bagimsiz.

Bu betik teshisi bir adim ileri goturur ve su soruyu ayirir:

    (a) sorun OZELLIK SAYISI mi?          -> rastgele veriyle de cokmeli
    (b) sorun VERININ YAPISI mi?          -> yalnizca gercek dozajlarla cokmeli
    (c) sorun KUANTIZASYON GENISLIGI mi?  -> n_bits dusunce duzelemeli

Her deneme AYRI BIR SURECTE kosar. Sebep: cokme bir Python istisnasi degil,
surecin olumu; ayni surecte denenirse ilk cokmede betik de olur ve geri kalan
olculemez.

Kullanim:
    .venv/bin/python tests/panel_ceiling_probe.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

#: Denenecek panel boyutlari. 16 bilinen calisan, 20 bilinen coken deger.
SIZES = [16, 18, 20, 24, 32, 48, 64]

#: Tek bir denemeyi AYRI surecte kosan cocuk betik.
CHILD = r'''
import json, sys, time, warnings
warnings.filterwarnings("ignore")

size = int(sys.argv[1])
mode = sys.argv[2]          # "real" | "random"
n_bits = int(sys.argv[3])

import numpy as np
from concrete.ml.sklearn import LogisticRegression

if mode == "real":
    sys.path.insert(0, sys.argv[4])
    from src.genomic.model import load_cohort, select_panel
    cohort = load_cohort()
    X = cohort.dosages.astype(np.float64)
    y = cohort.labels
    idx = select_panel(X, y, size)
    Xp = X[:, idx]
else:
    rng = np.random.default_rng(42)
    # Gercek dozajlarla AYNI alfabe: 0/1/2, ayni satir sayisi.
    Xp = rng.integers(0, 3, size=(2504, size)).astype(np.float64)
    y = rng.integers(0, 2, size=2504)

model = LogisticRegression(n_bits=n_bits)
model.fit(Xp, y)

started = time.perf_counter()
model.compile(Xp)
elapsed = time.perf_counter() - started

print(json.dumps({"ok": True, "seconds": round(elapsed, 2), "shape": list(Xp.shape)}))
'''


def run_one(size: int, mode: str, n_bits: int) -> dict:
    """Tek denemeyi ayri surecte kosar; cokmeyi hata degil VERI olarak doner."""
    result = subprocess.run(
        [sys.executable, "-c", CHILD, str(size), mode, str(n_bits), str(ROOT)],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )

    if result.returncode == 0:
        for line in reversed(result.stdout.strip().splitlines()):
            if line.startswith("{"):
                return {"status": "ok", **json.loads(line)}
        return {"status": "ok", "seconds": None}

    # Negatif donus kodu = sinyalle olum (SIGSEGV/SIGABRT) -> derleyici cokmesi.
    # Pozitif = Python istisnasi -> bambaska bir sey.
    kind = "COKME (sinyal)" if result.returncode < 0 else "istisna"
    tail = (result.stderr or result.stdout).strip().splitlines()
    return {
        "status": "fail",
        "kind": kind,
        "returncode": result.returncode,
        "detail": tail[-1] if tail else "(cikti yok)",
    }


def main() -> None:
    print("Panel tavani teshisi — her deneme ayri surecte\n")
    findings: dict[str, dict[int, dict]] = {}

    for mode in ("random", "real"):
        label = "RASTGELE 0/1/2" if mode == "random" else "GERCEK chrMT dozajlari"
        print(f"--- {label} (n_bits=8) ---")
        findings[mode] = {}

        for size in SIZES:
            outcome = run_one(size, mode, 8)
            findings[mode][size] = outcome

            if outcome["status"] == "ok":
                print(f"  panel {size:3d}: derlendi ({outcome.get('seconds')} sn)")
            else:
                print(f"  panel {size:3d}: {outcome['kind']} — {outcome['detail'][:90]}")
                # Ilk cokmeden sonrasini denemek gereksiz: daha buyugu de coker.
                break
        print()

    # Kuantizasyon genisligi cokmeyi degistiriyor mu?
    real_sizes = findings.get("real", {})
    first_fail = next(
        (s for s, o in sorted(real_sizes.items()) if o["status"] == "fail"), None
    )
    if first_fail:
        print(f"--- GERCEK veri, panel {first_fail}, farkli n_bits ---")
        for n_bits in (6, 4, 2):
            outcome = run_one(first_fail, "real", n_bits)
            if outcome["status"] == "ok":
                print(f"  n_bits {n_bits}: DERLENDI ({outcome.get('seconds')} sn)")
            else:
                print(f"  n_bits {n_bits}: {outcome['kind']}")
        print()

    print("=== SONUC ===")
    rnd = findings.get("random", {})
    rnd_max = max((s for s, o in rnd.items() if o["status"] == "ok"), default=0)
    real_max = max((s for s, o in real_sizes.items() if o["status"] == "ok"), default=0)

    print(f"rastgele veriyle derlenen en buyuk panel : {rnd_max}")
    print(f"gercek veriyle derlenen en buyuk panel   : {real_max}")

    if rnd_max > real_max:
        print("\n-> Sinir VERIYE OZGU: ayni sekil rastgele veriyle derleniyor.")
    elif rnd_max == real_max and rnd_max > 0:
        print("\n-> Sinir OZELLIK SAYISINA bagli: veri fark etmiyor.")


if __name__ == "__main__":
    main()
