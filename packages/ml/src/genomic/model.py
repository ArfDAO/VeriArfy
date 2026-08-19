"""VeriArfy — sifreli genomik cikarim: egitim, kuantizasyon ve derleme.

Bu modul sunucunun ayaga kalkarken **bir kez** yaptigi isi yapar:

    gercek VCF  ->  dozaj matrisi  ->  panel secimi  ->  egitim
                ->  n_bits=8 kuantizasyon  ->  FHE devresi derleme
                ->  dagitim artefaktlari (client.zip / server.zip)

VERI
    Egitim verisi sentetik degildir. 1000 Genomes Phase 3 chrMT cagrilari
    (2504 gercek birey) ve resmi ornek paneli kullanilir. Etiket, bireyin
    super-populasyonudur; mitokondriyal DNA anne soyunu gercekten tasidigi
    icin bu gecerli bir sinyaldir.

    NOT — Bu, klinik hedefin (anksiyete fenotipi) YERINE GECEN bir gorevdir.
    Elimizde henuz gercek fenotip etiketi yok; boru hattinin ucdan uca dogru
    calistigini gercek veriyle gostermek icin gercek bir etiket secildi.
    Fenotip verisi geldiginde yalnizca `LABEL_*` ayarlari degisir.

GIZLILIK
    Bu modulun urettigi sunucu artefakti (`server.zip`) gizli anahtar
    ICERMEZ. Gizli anahtar yalnizca istemcide uretilir ve orada kalir.
"""

from __future__ import annotations

import gzip
import json
import logging
import os
import shutil
import time
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable

import numpy as np

# IMPORT SIRASI ONEMLI — DEGISTIRMEYIN.
#
# `concrete.ml.sklearn` MUTLAKA `concrete.ml.deployment`'tan ONCE gelmelidir.
# Ters sirada Concrete'in yerel/LLVM baslatmasi bozuluyor ve derleme, devre
# belli bir karmasikligi asinca **surec olumuyle** (SIGABRT, "Pure virtual
# function called") duşuyor. Python istisnasi olmadigi icin yakalanamaz.
#
# Bu, uzun sure "panel >= 20'de LLVM cokuyor" diye YANLIS TESHIS edildi ve
# `VERIFIED_MAX_PANEL_SIZE = 16` olarak kayda gecti. Gercek sebep bu iki
# satirin sirasiydi: sira duzeltilince ayni veriyle panel 3892'ye kadar
# derleniyor (bkz. `tests/panel_scale_probe.py`).
from concrete.ml.sklearn import LogisticRegression
from concrete.ml.deployment import FHEModelDev
from sklearn.metrics import accuracy_score, roc_auc_score
from sklearn.model_selection import train_test_split

logger = logging.getLogger("veriarfy.genomic.model")

# --------------------------------------------------------------------------------------
# Yapilandirma
# --------------------------------------------------------------------------------------

PACKAGE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("VERIARFY_DATA_DIR", PACKAGE_DIR / "data"))
DEPLOYMENT_DIR = Path(os.environ.get("VERIARFY_DEPLOYMENT_DIR", PACKAGE_DIR / "deployment"))

VCF_URL = (
    "https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/release/20130502/"
    "ALL.chrMT.phase3_callmom-v0_4.20130502.genotypes.vcf.gz"
)
PANEL_URL = (
    "https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/release/20130502/"
    "integrated_call_samples_v3.20130502.ALL.panel"
)

VCF_PATH = DATA_DIR / "chrMT.vcf.gz"
PANEL_PATH = DATA_DIR / "samples.panel"

#: Pozitif sinif. Fenotip verisi geldiginde burasi degisir.
LABEL_COLUMN = os.environ.get("VERIARFY_LABEL_COLUMN", "super_pop")
LABEL_POSITIVE = os.environ.get("VERIARFY_LABEL_POSITIVE", "AFR")

#: Sifreli devreye girecek varyant sayisi.
PANEL_SIZE = int(os.environ.get("VERIARFY_PANEL_SIZE", "16"))

#: Bu veriyle derlenebildigi OLCULEN en buyuk panel.
#:
#: ESKI DEGER 16'YDI VE YANLIS TESHISE DAYANIYORDU.
#:
#: Kayitli gerekce suydu: "panel >= 20'de Concrete'in LLVM arka ucu surec
#: olumuyle cokuyor, n_bits/duzenlilestirme/derleme kumesi degisikliklerinden
#: bagimsiz". Cokme gercekti; ama sebebi panel boyutu DEGILDI — yukaridaki iki
#: import satirinin SIRASIYDI. Sira duzeltilince ayni veri, ayni surum ve ayni
#: parametrelerle chrMT'nin TAMAMI derleniyor.
#:
#: Olculen (tests/panel_scale_probe.py, tam boru hatti + gercek FHE cikarimi):
#:
#:     panel    AUC     derleme   FHE gecikmesi
#:        16   0.951      0.6 sn      0.53 sn
#:       256   0.994      0.4 sn      0.40 sn
#:      3892   0.996      0.5 sn      0.63 sn
#:
#: 3892 = chrMT'deki toplam varyant sayisi, yani VERININ siniri — derleyicinin
#: degil. Daha buyuk panel icin nukleer kromozom verisi gerekir.
VERIFIED_MAX_PANEL_SIZE = int(os.environ.get("VERIARFY_MAX_PANEL_SIZE", "3892"))

#: Zama kuantizasyon genisligi.
N_BITS = int(os.environ.get("VERIARFY_N_BITS", "8"))

RANDOM_STATE = 42


class ModelError(RuntimeError):
    """Egitim/derleme hattinda kurtarilamayan hata."""


# --------------------------------------------------------------------------------------
# Veri
# --------------------------------------------------------------------------------------


def _download(url: str, target: Path) -> Path:
    """Dosyayi indirir ve onbellege alir. Var olan dosya yeniden indirilmez."""
    if target.exists() and target.stat().st_size > 0:
        return target

    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".part")
    logger.info("indiriliyor: %s", url)

    try:
        with urllib.request.urlopen(url, timeout=120) as response, tmp.open("wb") as out:
            shutil.copyfileobj(response, out)
    except Exception as exc:  # ag hatasi, 404, zaman asimi...
        tmp.unlink(missing_ok=True)
        raise ModelError(f"veri indirilemedi ({url}): {exc}") from exc

    tmp.replace(target)
    return target


def _open_vcf(path: Path):
    """VCF'i duz ya da gzip olarak acar."""
    if path.suffix == ".gz":
        return gzip.open(path, "rt")
    return path.open("rt")


@dataclass(frozen=True)
class Cohort:
    """Egitim icin hazir gercek kohort."""

    dosages: np.ndarray  # (ornek, varyant) uint8, degerler 0|1|2
    labels: np.ndarray  # (ornek,) 0|1
    sample_ids: list[str]
    variant_ids: list[str]

    def __post_init__(self) -> None:
        if self.dosages.shape[0] != self.labels.shape[0]:
            raise ModelError("dozaj matrisi ile etiket sayisi uyusmuyor")


def _parse_genotype(field: str) -> int:
    """GT alanini dozaja cevirir — Faz 1'deki Rust parser ile ayni kural.

    Referans olmayan alel sayisi, 2 ile sinirli. Cagrilamamis (`.`) genotip 0
    yazilir; hizalamayi bozmamak icin satir atlanmaz.
    """
    gt = field.split(":", 1)[0].replace("|", "/")
    alleles = gt.split("/")
    if any(a == "." or a == "" for a in alleles):
        return 0
    return min(2, sum(1 for a in alleles if a != "0"))


def load_cohort(
    vcf_path: Path | None = None,
    panel_path: Path | None = None,
) -> Cohort:
    """Gercek VCF + resmi ornek panelinden dozaj matrisi ve etiketleri kurar."""
    vcf_path = vcf_path or _download(VCF_URL, VCF_PATH)
    panel_path = panel_path or _download(PANEL_URL, PANEL_PATH)

    # --- etiketler ---
    labels_by_sample: dict[str, str] = {}
    with panel_path.open() as handle:
        header = handle.readline().rstrip("\n").split("\t")
        try:
            label_index = header.index(LABEL_COLUMN)
        except ValueError as exc:
            raise ModelError(
                f"panel dosyasinda '{LABEL_COLUMN}' kolonu yok (kolonlar: {header})"
            ) from exc

        for line in handle:
            parts = line.rstrip("\n").split("\t")
            if len(parts) > label_index and parts[0]:
                labels_by_sample[parts[0]] = parts[label_index]

    if not labels_by_sample:
        raise ModelError(f"panel dosyasi bos ya da okunamadi: {panel_path}")

    # --- dozajlar ---
    rows: list[np.ndarray] = []
    variant_ids: list[str] = []
    keep_columns: list[int] = []
    sample_ids: list[str] = []

    with _open_vcf(vcf_path) as handle:
        for line in handle:
            if line.startswith("##"):
                continue

            parts = line.rstrip("\n").split("\t")

            if line.startswith("#CHROM"):
                # Yalnizca etiketi bilinen ornekleri tut.
                for column, name in enumerate(parts[9:], start=9):
                    if name in labels_by_sample:
                        keep_columns.append(column)
                        sample_ids.append(name)
                if not sample_ids:
                    raise ModelError("VCF ornekleri ile panel ornekleri kesismiyor")
                continue

            if len(parts) < 10:
                continue

            fmt = parts[8].split(":")
            if "GT" not in fmt:
                continue  # sadece-site satiri

            gt_index = fmt.index("GT")
            row = np.empty(len(keep_columns), dtype=np.uint8)
            for i, column in enumerate(keep_columns):
                sub = parts[column].split(":")
                row[i] = _parse_genotype(sub[gt_index]) if gt_index < len(sub) else 0

            rows.append(row)
            variant_ids.append(parts[2] if parts[2] != "." else f"{parts[0]}:{parts[1]}")

    if not rows:
        raise ModelError(f"VCF'te kullanilabilir varyant yok: {vcf_path}")

    dosages = np.vstack(rows).T  # (ornek, varyant)
    labels = np.array(
        [1 if labels_by_sample[s] == LABEL_POSITIVE else 0 for s in sample_ids],
        dtype=np.int64,
    )

    logger.info(
        "kohort: %d ornek x %d varyant, pozitif sinif orani %.3f",
        dosages.shape[0],
        dosages.shape[1],
        labels.mean(),
    )
    return Cohort(dosages=dosages, labels=labels, sample_ids=sample_ids, variant_ids=variant_ids)


# --------------------------------------------------------------------------------------
# Panel secimi
# --------------------------------------------------------------------------------------


def select_panel(X: np.ndarray, y: np.ndarray, size: int) -> np.ndarray:
    """Etiketle en guclu iliskili `size` varyantin indekslerini dondurur.

    **Yalnizca egitim bolumunde** cagrilmalidir: test verisiyle secim yapmak
    sizinti (leakage) yaratir ve dogrulugu yapay olarak yukseltir.
    """
    if size <= 0:
        raise ModelError(f"panel boyutu pozitif olmali: {size}")

    Xf = X.astype(np.float64)
    x_std = Xf.std(axis=0)
    y_std = y.std()

    if y_std == 0:
        raise ModelError("etiketlerin tamami ayni sinifta — model egitilemez")

    # Sabit varyantlar (hicbir ornekte degismeyen) hicbir bilgi tasimaz.
    informative = x_std > 0
    corr = np.zeros(X.shape[1], dtype=np.float64)
    corr[informative] = (
        ((Xf[:, informative] - Xf[:, informative].mean(axis=0)) * (y - y.mean())[:, None]).mean(axis=0)
        / (x_std[informative] * y_std)
    )

    ranked = np.argsort(-np.abs(corr))
    chosen = ranked[: min(size, int(informative.sum()))]

    if chosen.size == 0:
        raise ModelError("bilgi tasiyan varyant bulunamadi")
    if chosen.size < size:
        logger.warning("istenen panel %d, bulunan %d bilgi tasiyan varyant", size, chosen.size)

    return np.sort(chosen)


# --------------------------------------------------------------------------------------
# Egitim + derleme
# --------------------------------------------------------------------------------------


@dataclass
class TrainingReport:
    """Egitim sonucu — /health uzerinden yayinlanir."""

    n_samples: int
    n_variants_total: int
    panel_size: int
    n_bits: int
    label: str
    positive_rate: float
    plain_accuracy: float
    quantized_accuracy: float
    roc_auc: float
    fhe_accuracy: float | None
    fhe_samples_checked: int
    compile_seconds: float
    fhe_latency_seconds: float | None

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class Deployment:
    """Sunucunun calismak icin ihtiyac duydugu her sey."""

    path: Path
    panel_indices: list[int]
    panel_variant_ids: list[str]
    report: TrainingReport


def train_and_deploy(
    output_dir: Path | None = None,
    panel_size: int = PANEL_SIZE,
    n_bits: int = N_BITS,
    fhe_check_samples: int = 2,
    allow_unverified_panel: bool = False,
) -> Deployment:
    """Gercek veriyle egitir, FHE devresini derler ve artefaktlari yazar.

    `fhe_check_samples > 0` ise derlemeden sonra birkac ornek **gercek FHE**
    ile calistirilip kuantize sonucla karsilastirilir. Bu, "derlendi ama
    yanlis cevap veriyor" durumunu ayaga kalkarken yakalar.
    """
    output_dir = Path(output_dir or DEPLOYMENT_DIR)

    if panel_size > VERIFIED_MAX_PANEL_SIZE and not allow_unverified_panel:
        raise ModelError(
            f"panel boyutu {panel_size}, dogrulanmis ust sinir {VERIFIED_MAX_PANEL_SIZE}. "
            "Bunun uzerinde Concrete'in LLVM arka ucu surec olumuyle cokuyor ve hata "
            "yakalanamiyor; sunucu sessizce olecegine burada duruyor. Yine de denemek "
            "icin allow_unverified_panel=True verin."
        )

    cohort = load_cohort()

    X_train, X_test, y_train, y_test = train_test_split(
        cohort.dosages,
        cohort.labels,
        test_size=0.2,
        random_state=RANDOM_STATE,
        stratify=cohort.labels,
    )

    # Panel SADECE egitim bolumunden secilir (sizinti olmasin).
    panel = select_panel(X_train, y_train, panel_size)
    X_train_p = X_train[:, panel].astype(np.float64)
    X_test_p = X_test[:, panel].astype(np.float64)

    model = LogisticRegression(n_bits=n_bits, random_state=RANDOM_STATE, max_iter=1000)
    model.fit(X_train_p, y_train)

    # Kuantize (FHE ile ayni aritmetigi kullanan) tahminler.
    y_pred_quant = model.predict(X_test_p)
    quantized_accuracy = float(accuracy_score(y_test, y_pred_quant))

    # Kuantizasyonsuz sklearn karsiligi — kuantizasyonun bedelini olcmek icin.
    plain_accuracy = float(accuracy_score(y_test, model.sklearn_model.predict(X_test_p)))

    try:
        scores = model.sklearn_model.decision_function(X_test_p)
        roc_auc = float(roc_auc_score(y_test, scores))
    except ValueError:
        roc_auc = float("nan")

    logger.info("derleniyor (n_bits=%d, panel=%d)...", n_bits, panel.size)
    started = time.perf_counter()
    model.compile(X_train_p)
    compile_seconds = time.perf_counter() - started
    logger.info("derleme tamam: %.1f sn", compile_seconds)

    # --- gercek FHE ile dogrulama ---
    fhe_accuracy: float | None = None
    fhe_latency: float | None = None
    checked = 0

    if fhe_check_samples > 0:
        sample_count = min(fhe_check_samples, X_test_p.shape[0])
        started = time.perf_counter()
        fhe_pred = model.predict(X_test_p[:sample_count], fhe="execute")
        fhe_latency = (time.perf_counter() - started) / max(sample_count, 1)
        fhe_accuracy = float(accuracy_score(y_test[:sample_count], fhe_pred))
        checked = sample_count
        logger.info(
            "FHE dogrulama: %d ornek, ornek basina %.2f sn, dogruluk %.2f",
            checked,
            fhe_latency,
            fhe_accuracy,
        )

    report = TrainingReport(
        n_samples=int(cohort.dosages.shape[0]),
        n_variants_total=int(cohort.dosages.shape[1]),
        panel_size=int(panel.size),
        n_bits=n_bits,
        label=f"{LABEL_COLUMN}=={LABEL_POSITIVE}",
        positive_rate=float(cohort.labels.mean()),
        plain_accuracy=plain_accuracy,
        quantized_accuracy=quantized_accuracy,
        roc_auc=roc_auc,
        fhe_accuracy=fhe_accuracy,
        fhe_samples_checked=checked,
        compile_seconds=compile_seconds,
        fhe_latency_seconds=fhe_latency,
    )

    # --- dagitim artefaktlari ---
    # FHEModelDev var olan dizine yazmayi reddeder; her derlemede temizlenir.
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    FHEModelDev(path_dir=str(output_dir), model=model).save()

    panel_variant_ids = [cohort.variant_ids[i] for i in panel]
    (output_dir / "panel.json").write_text(
        json.dumps(
            {
                "panel_indices": [int(i) for i in panel],
                "panel_variant_ids": panel_variant_ids,
                "n_bits": n_bits,
                "label": report.label,
                "source_vcf": VCF_URL,
            },
            indent=2,
        )
    )
    (output_dir / "report.json").write_text(json.dumps(report.as_dict(), indent=2))

    _assert_no_secret_key(output_dir)

    return Deployment(
        path=output_dir,
        panel_indices=[int(i) for i in panel],
        panel_variant_ids=panel_variant_ids,
        report=report,
    )


def _assert_no_secret_key(deployment_dir: Path) -> None:
    """Sunucu artefaktinin sifre cozemeyecegini dogrular.

    Bu kontrat projenin butun gizlilik iddiasini tasir; sessizce ihlal
    edilmesindense sunucunun hic acilmamasi yeglenir.

    Not: `client.specs.json` her iki zip'te de bulunur ve gizli anahtar
    DEGILDIR — sifrelemek icin gereken acik devre parametreleridir. Gizli
    anahtar hicbir artefakta yazilmaz; istemci onu calisma aninda kendi
    uretir ve kendi `key_dir`'inde tutar.
    """
    import zipfile

    from concrete.ml.deployment import FHEModelServer

    server_zip = deployment_dir / "server.zip"
    if not server_zip.exists():
        raise ModelError("dagitim artefakti uretilemedi: server.zip yok")

    # 1) Artefaktta anahtar malzemesi izi olmamali.
    forbidden = ("secret", "private", ".key", "keyset")
    with zipfile.ZipFile(server_zip) as archive:
        names = [n.lower() for n in archive.namelist()]
        leaked = [n for n in names if any(f in n for f in forbidden)]
        if leaked:
            raise ModelError(f"server.zip icinde anahtar malzemesi var: {leaked}")

        # 2) Anahtar kumesi tanimi yalnizca PARAMETRE tasimali.
        #
        #    `client.specs.json` icindeki `keyset.lweSecretKeys` alani, adina
        #    ragmen anahtar DEGERI icermez; istemcinin uretecegi anahtarin
        #    boyutunu tarif eder ({id, params:{lweDimension, ...}}). Metinde
        #    "secret" gecmesi normaldir — onemli olan, orada bir veri blogu
        #    bulunmamasidir. Beklenmeyen bir alan cikarsa durulur.
        import json as _json

        specs = _json.loads(archive.read("client.specs.json"))
        allowed = {"id", "params"}
        for entry in specs.get("keyset", {}).get("lweSecretKeys", []):
            unexpected = set(entry) - allowed
            if unexpected:
                raise ModelError(
                    f"anahtar kumesi tanimimda beklenmeyen alan(lar): {sorted(unexpected)} "
                    "— burada yalnizca parametre olmali, anahtar degeri olmamali"
                )

    # 3) Sunucu sinifinin cozme yetenegi hic olmamali. Asil garanti budur:
    #    FHEModelServer API'sinde decrypt yoktur; cozme yalnizca istemcidedir.
    decrypting = [a for a in dir(FHEModelServer) if "decrypt" in a.lower()]
    if decrypting:
        raise ModelError(f"FHEModelServer cozme yetenegi tasiyor: {decrypting}")


def load_panel(deployment_dir: Path) -> dict:
    """Kayitli panel tanimini okur."""
    path = Path(deployment_dir) / "panel.json"
    if not path.exists():
        raise ModelError(f"panel tanimi yok: {path}")
    return json.loads(path.read_text())


if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    deployment = train_and_deploy()
    print(json.dumps(deployment.report.as_dict(), indent=2))
    print(f"\nartefaktlar: {deployment.path}")
