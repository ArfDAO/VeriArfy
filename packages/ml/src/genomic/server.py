"""VeriArfy — sifreli genomik cikarim sunucusu (FastAPI).

SUNUCU NE GORUR?
    Hicbir sey. Gelen dozajlar sifrelidir, cikan tahmin sifrelidir. Sunucu
    gizli anahtara sahip degildir ve `concrete-ml`'in sunucu API'sinde
    (`FHEModelServer`) cozme fonksiyonu **yoktur** — bu, yorumla degil
    ayaga kalkarken calisan bir kontrolle dogrulanir (`model._assert_no_secret_key`).

AKIS
    1. Istemci  GET  /api/keys/specs      -> devre tanimini (client.zip) indirir
    2. Istemci  yerelde anahtarlarini uretir; GIZLI ANAHTAR CIHAZDAN CIKMAZ
    3. Istemci  POST /api/analyze         -> {ciphertext, evaluation_keys}
    4. Sunucu   sifreli veri uzerinde devreyi kosar
    5. Istemci  donen ciphertext_result'i KENDI gizli anahtariyla cozer

"ZAMA PUBLIC KEY" NOTU
    concrete-ml'de sunucuya "public key" gonderilmez; **evaluation keys**
    (bootstrap + keyswitch anahtarlari) gonderilir. Bunlar sifre cozmez,
    yalnizca sifreli veri uzerinde islem yapmayi mumkun kilar ve derlenen
    devreye ozeldir — baska bir modelin anahtariyla calismaz.
"""

from __future__ import annotations

import base64
import binascii
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from concrete.ml.deployment import FHEModelServer

from . import model as model_module
from .model import DEPLOYMENT_DIR, ModelError, load_panel, train_and_deploy

logger = logging.getLogger("veriarfy.genomic.server")

#: Govde siniri. Evaluation key'ler onlarca MB olabilir; sinirsiz birakmak
#: sunucuyu tek istekle dusurmeye acik birakirdi.
MAX_PAYLOAD_BYTES = int(os.environ.get("VERIARFY_MAX_PAYLOAD_BYTES", str(200 * 1024 * 1024)))

#: Artefaktlar varsa yeniden egitme; yoksa ayaga kalkarken bir kez egit.
FORCE_RETRAIN = os.environ.get("VERIARFY_FORCE_RETRAIN", "").lower() in {"1", "true", "yes"}

ALLOWED_ORIGINS = [o for o in os.environ.get("VERIARFY_CORS_ORIGINS", "*").split(",") if o]


class _State:
    """Surec omru boyunca yasayan hazir devre."""

    server: FHEModelServer | None = None
    panel: dict | None = None
    report: dict | None = None
    deployment_dir: Path = DEPLOYMENT_DIR
    ready: bool = False
    error: str | None = None


state = _State()


def _bootstrap() -> None:
    """Modeli hazirlar: artefakt varsa yukler, yoksa bir kez egitip derler."""
    deployment_dir = Path(os.environ.get("VERIARFY_DEPLOYMENT_DIR", DEPLOYMENT_DIR))
    needs_training = FORCE_RETRAIN or not (deployment_dir / "server.zip").exists()

    if needs_training:
        logger.info("dagitim artefakti yok — egitim ve derleme yapiliyor (bir kez)")
        started = time.perf_counter()
        deployment = train_and_deploy(output_dir=deployment_dir)
        logger.info("hazir: %.1f sn", time.perf_counter() - started)
        state.report = deployment.report.as_dict()
    else:
        logger.info("mevcut artefaktlar yukleniyor: %s", deployment_dir)
        import json

        report_path = deployment_dir / "report.json"
        state.report = json.loads(report_path.read_text()) if report_path.exists() else None

    # Artefakt diskten geldiyse de gizlilik kontratini dogrula.
    model_module._assert_no_secret_key(deployment_dir)

    fhe_server = FHEModelServer(path_dir=str(deployment_dir))
    fhe_server.load()

    state.server = fhe_server
    state.panel = load_panel(deployment_dir)
    state.deployment_dir = deployment_dir
    state.ready = True
    logger.info("sifreli cikarim hazir (panel %d varyant)", len(state.panel["panel_indices"]))


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        _bootstrap()
    except Exception as exc:  # noqa: BLE001 — nedeni /health uzerinden gorunur
        state.error = str(exc)
        state.ready = False
        logger.exception("baslatma basarisiz")
    yield


app = FastAPI(
    title="VeriArfy — Sifreli Genomik Cikarim",
    description="Veri hicbir noktada cozulmez. Sunucu gizli anahtara sahip degildir.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS or ["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["content-type"],
)


# --------------------------------------------------------------------------------------
# Semalar
# --------------------------------------------------------------------------------------


class AnalyzeRequest(BaseModel):
    """Istemciden gelen sifreli istek.

    Iki alan da base64'tur; ikisi de **sifre cozmeye yaramaz**.
    """

    ciphertext: str = Field(
        ...,
        description="FHEModelClient.quantize_encrypt_serialize ciktisi (base64)",
        min_length=1,
    )
    evaluation_keys: str = Field(
        ...,
        description="FHEModelClient.get_serialized_evaluation_keys ciktisi (base64)",
        min_length=1,
    )


class AnalyzeResponse(BaseModel):
    ciphertext_result: str = Field(..., description="Sifreli tahmin (base64)")
    panel_size: int
    n_bits: int
    label: str
    compute_seconds: float
    note: str


class HealthResponse(BaseModel):
    ready: bool
    error: str | None
    panel_size: int | None
    label: str | None
    report: dict | None


# --------------------------------------------------------------------------------------
# Yardimcilar
# --------------------------------------------------------------------------------------


def _require_ready() -> FHEModelServer:
    if not state.ready or state.server is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=state.error or "model henuz hazir degil",
        )
    return state.server


def _decode(field: str, value: str) -> bytes:
    """base64 cozer; bozuk girdiyi 400 ile geri cevirir."""
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"{field} gecerli base64 degil: {exc}",
        ) from exc

    if not raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{field} bos")

    if len(raw) > MAX_PAYLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"{field} cok buyuk ({len(raw)} bayt > {MAX_PAYLOAD_BYTES})",
        )

    return raw


# --------------------------------------------------------------------------------------
# Uc noktalar
# --------------------------------------------------------------------------------------


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Hazir mi, hangi panelle, hangi dogrulukla?"""
    return HealthResponse(
        ready=state.ready,
        error=state.error,
        panel_size=len(state.panel["panel_indices"]) if state.panel else None,
        label=state.panel.get("label") if state.panel else None,
        report=state.report,
    )


@app.get("/api/panel")
async def panel() -> dict:
    """Istemcinin hangi varyantlari sifrelemesi gerektigi.

    Faz 1 ciktisindaki indeksler ve varyant kimlikleri birlikte dondurulur;
    istemci ile sunucu ayni sirayi kullanmazsa tahmin sessizce anlamsizlasir.
    """
    _require_ready()
    assert state.panel is not None
    return state.panel


@app.get("/api/keys/specs")
async def client_specs() -> Response:
    """Istemcinin anahtar uretmek icin indirecegi devre tanimi (client.zip).

    Bu paket ACIK parametrelerdir; gizli anahtar icermez. Istemci bunu alip
    kendi anahtarlarini kendi cihazinda uretir.
    """
    _require_ready()
    path = state.deployment_dir / "client.zip"
    if not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "client.zip bulunamadi")

    return Response(
        content=path.read_bytes(),
        media_type="application/zip",
        headers={"content-disposition": 'attachment; filename="client.zip"'},
    )


@app.post("/api/analyze", response_model=AnalyzeResponse)
async def analyze(request: AnalyzeRequest) -> AnalyzeResponse:
    """Sifreli dozajlar uzerinde sifreli tahmin uretir.

    Girdi de cikti da sifrelidir. Sunucu ne girdiyi ne de sonucu gorebilir;
    sonucu yalnizca gizli anahtarin sahibi cozebilir.
    """
    fhe_server = _require_ready()

    ciphertext = _decode("ciphertext", request.ciphertext)
    evaluation_keys = _decode("evaluation_keys", request.evaluation_keys)

    started = time.perf_counter()
    try:
        encrypted_result = fhe_server.run(
            serialized_encrypted_quantized_data=ciphertext,
            serialized_evaluation_keys=evaluation_keys,
        )
    except Exception as exc:  # noqa: BLE001
        # Tipik neden: baska bir derlemeye ait anahtar/ciphertext. Ic ayrinti
        # sizdirilmadan, duzeltilebilir bir mesaj dondurulur.
        logger.warning("sifreli cikarim reddedildi: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "sifreli veri bu devreyle uyusmuyor. Anahtarlarinizi "
                "/api/keys/specs ile indirdiginiz guncel tanimdan uretin."
            ),
        ) from exc

    compute_seconds = time.perf_counter() - started

    if not isinstance(encrypted_result, (bytes, bytearray)):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="devre beklenmeyen bicimde sonuc dondurdu",
        )

    assert state.panel is not None
    logger.info("sifreli cikarim tamam: %.3f sn, %d bayt", compute_seconds, len(encrypted_result))

    return AnalyzeResponse(
        ciphertext_result=base64.b64encode(bytes(encrypted_result)).decode("ascii"),
        panel_size=len(state.panel["panel_indices"]),
        n_bits=int(state.panel["n_bits"]),
        label=str(state.panel["label"]),
        compute_seconds=round(compute_seconds, 4),
        note="Sonuc sifrelidir. Yalnizca kendi gizli anahtarinizla cozebilirsiniz.",
    )
