"""
Derleyicinin GERCEK tavani nerede? — "milyonlarca SNP" hedefinin olculmesi.

`panel_scale_probe.py` chrMT'nin tamamini (3892 varyant) derleyebildigimizi
gosterdi. Ama chrMT verinin siniriydi, derleyicinin degil. Bu betik sinirin
kendisini arar: sentetik 0/1/2 dozajlarla ozellik sayisi katlanarak artirilir.

Neden sentetik veri MESRU: burada olculen sey model dogrulugu degil,
DERLEYICININ KAPASITESI. Dogruluk zaten gercek veriyle olculdu (AUC 0.996).
Kapasite sorusu icin veri icerigi degil, sekli onemlidir.

Her deneme ayri surecte kosar ve sonucu dosyaya yazar; cikis kodu
guvenilmezdir (Concrete'in kapanis davranisi).

Kullanim:
    .venv/bin/python tests/compiler_limit_probe.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

#: Katlanarak artan ozellik sayilari.
SIZES = [4_096, 16_384, 65_536, 262_144, 1_048_576]

#: Ornek sayisi sabit tutulur: degisen tek sey ozellik sayisi olmali.
N_SAMPLES = 512

CHILD = r'''
import json, sys, time, warnings, resource
warnings.filterwarnings("ignore")

n_features = int(sys.argv[1])
n_samples = int(sys.argv[2])
out_path = sys.argv[3]

import numpy as np
# SIRA ONEMLI: sklearn once (bkz. src/genomic/model.py aciklamasi).
from concrete.ml.sklearn import LogisticRegression

rng = np.random.default_rng(7)
X = rng.integers(0, 3, size=(n_samples, n_features)).astype(np.float64)
# Gercege yakin bir sinyal: ilk 32 ozellik etiketi belirlesin.
signal = X[:, :32].sum(axis=1)
y = (signal > np.median(signal)).astype(int)

t = time.perf_counter()
model = LogisticRegression(n_bits=8)
model.fit(X, y)
fit_s = time.perf_counter() - t

t = time.perf_counter()
model.compile(X)
compile_s = time.perf_counter() - t

t = time.perf_counter()
model.predict(X[:1], fhe="execute")
fhe_s = time.perf_counter() - t

peak_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024

with open(out_path, "w") as handle:
    json.dump({
        "features": n_features,
        "fit_s": round(fit_s, 2),
        "compile_s": round(compile_s, 2),
        "fhe_s": round(fhe_s, 2),
        "peak_mb": round(peak_kb / 1024, 1),
    }, handle)
'''


def run_one(n_features: int) -> dict:
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as handle:
        out_path = handle.name

    result = subprocess.run(
        [sys.executable, "-c", CHILD, str(n_features), str(N_SAMPLES), out_path],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )

    try:
        return json.loads(Path(out_path).read_text())
    except (json.JSONDecodeError, FileNotFoundError, ValueError):
        tail = (result.stderr or "").strip().splitlines()
        return {
            "features": n_features,
            "failed": True,
            "exit_code": result.returncode,
            "detail": tail[-1][:100] if tail else "(cikti yok)",
        }
    finally:
        Path(out_path).unlink(missing_ok=True)


def main() -> None:
    print(f"Derleyici tavani — {N_SAMPLES} ornek, artan ozellik sayisi\n")
    print(f"{'ozellik':>10} {'egitim':>9} {'derleme':>9} {'FHE':>8} {'bellek':>9}")
    print("-" * 50)

    results = []
    for size in SIZES:
        outcome = run_one(size)
        results.append(outcome)

        if outcome.get("failed"):
            print(f"{size:>10,} BASARISIZ (cikis {outcome['exit_code']}) {outcome['detail'][:40]}")
            break

        print(
            f"{outcome['features']:>10,} "
            f"{outcome['fit_s']:>8.1f}s "
            f"{outcome['compile_s']:>8.1f}s "
            f"{outcome['fhe_s']:>7.2f}s "
            f"{outcome['peak_mb']:>8.0f}MB"
        )

    ok = [r for r in results if not r.get("failed")]
    print("\n=== SONUC ===")
    if ok:
        best = max(r["features"] for r in ok)
        print(f"Derlenen en buyuk ozellik sayisi: {best:,}")
        if best >= 1_000_000:
            print("-> 'Milyonlarca SNP' derleyici acisindan ULASILABILIR.")
        else:
            print(f"-> Derleyici tavani {best:,} civarinda; milyon icin parcalama gerekir.")

    Path(HERE / "compiler_limit_results.json").write_text(json.dumps(results, indent=2))
    print(f"\nSonuclar: {HERE / 'compiler_limit_results.json'}")


if __name__ == "__main__":
    main()
