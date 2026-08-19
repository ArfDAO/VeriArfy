"""
Panel tavani GERCEKTEN var mi? Tam boru hatti, artan panel boyutlariyla.

`panel_ceiling_probe.py` sunu gosterdi: cokme derlemede degil, `import
concrete.ml.deployment` sirasinda ve SUREC KAPANISINDA olusuyor — is bittikten
sonra. Yani "panel >= 20'de LLVM cokuyor" teshisi yanlis taniydi: cikis kodu
134 gorulup derlemeye yorulmus.

Bu betik iddiayi tam boru hattiyla sinar: her panel boyutu icin egitim +
derleme + GERCEK FHE cikarimi kosar ve sonuclari dosyaya yazar. Cikis kodu
GUVENILMEZ oldugu icin basari, dosyaya yazilan cikti ile olculur.

Kullanim:
    .venv/bin/python tests/panel_scale_probe.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

#: chrMT'de toplam 3892 varyant var; ustune cikmak anlamsiz.
SIZES = [16, 32, 64, 128, 256, 512, 1024, 2048, 3892]

CHILD = r'''
import json, sys, time, warnings
warnings.filterwarnings("ignore")
sys.path.insert(0, sys.argv[3])

size = int(sys.argv[1])
out_path = sys.argv[2]

from src.genomic.model import train_and_deploy
import tempfile, pathlib

started = time.perf_counter()
with tempfile.TemporaryDirectory() as tmp:
    deployment = train_and_deploy(
        output_dir=pathlib.Path(tmp),
        panel_size=size,
        fhe_check_samples=1,
        allow_unverified_panel=True,
    )
    report = deployment.report

total = time.perf_counter() - started

# Cikis kodu guvenilmez (teardown cokmesi) — sonucu DOSYAYA yaz.
with open(out_path, "w") as handle:
    json.dump({
        "panel": size,
        "roc_auc": report.roc_auc,
        "quantized_accuracy": report.quantized_accuracy,
        "fhe_accuracy": report.fhe_accuracy,
        "compile_seconds": report.compile_seconds,
        "fhe_latency_seconds": report.fhe_latency_seconds,
        "total_seconds": round(total, 1),
    }, handle)
'''


def run_one(size: int) -> dict | None:
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as handle:
        out_path = handle.name

    result = subprocess.run(
        [sys.executable, "-c", CHILD, str(size), out_path, str(ROOT)],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )

    try:
        payload = json.loads(Path(out_path).read_text())
        payload["exit_code"] = result.returncode
        return payload
    except (json.JSONDecodeError, FileNotFoundError, ValueError):
        tail = (result.stderr or "").strip().splitlines()
        return {
            "panel": size,
            "failed": True,
            "exit_code": result.returncode,
            "detail": tail[-1] if tail else "(cikti yok)",
        }
    finally:
        Path(out_path).unlink(missing_ok=True)


def main() -> None:
    print("Panel olcekleme — tam boru hatti (egitim + derleme + gercek FHE)\n")
    print(f"{'panel':>6} {'AUC':>7} {'kuant':>7} {'FHE':>5} {'derleme':>9} {'FHE gec.':>9} {'cikis':>6}")
    print("-" * 60)

    results = []
    for size in SIZES:
        outcome = run_one(size)
        results.append(outcome)

        if outcome.get("failed"):
            print(f"{size:>6} {'BASARISIZ':>7}  {outcome['detail'][:40]}")
            break

        print(
            f"{outcome['panel']:>6} "
            f"{outcome['roc_auc']:>7.3f} "
            f"{outcome['quantized_accuracy']:>7.3f} "
            f"{str(outcome['fhe_accuracy']):>5} "
            f"{outcome['compile_seconds']:>8.1f}s "
            f"{outcome['fhe_latency_seconds']:>8.2f}s "
            f"{outcome['exit_code']:>6}"
        )

    ok = [r for r in results if not r.get("failed")]
    print("\n=== SONUC ===")
    if ok:
        best = max(r["panel"] for r in ok)
        print(f"Derlenen en buyuk panel : {best}")
        crashed_exits = {r["exit_code"] for r in ok if r["exit_code"] != 0}
        if crashed_exits:
            print(
                f"Cikis kodlari {sorted(crashed_exits)} — ama ISLER TAMAMLANDI.\n"
                "Bu, `concrete.ml.deployment` icindeki kapanis cokmesidir;\n"
                "hesaplamayi etkilemez, yalnizca cikis kodunu bozar."
            )

    Path(HERE / "panel_scale_results.json").write_text(json.dumps(results, indent=2))
    print(f"\nSonuclar: {HERE / 'panel_scale_results.json'}")


if __name__ == "__main__":
    main()
