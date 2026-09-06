# VeriArfy — sifreli cikarim servisi.
#
# NEDEN KONTEYNER, NEDEN SUNUCUSUZ DEGIL
#
# `concrete-ml` bagimliliklariyla birlikte ~2 GB. Vercel/Netlify gibi
# sunucusuz platformlarin paket siniri (250 MB) bunun cok altinda kaliyor.
# Bu yuzden servis kendi konteynerinde calisir.
FROM python:3.11-slim

# concrete-python native tekerlekler kullaniyor; derleme araclari gerekmez
# ama libgomp (OpenMP) calisma zamaninda aranir.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Once yalnizca gereksinimler: kod degistiginde katman onbellegi korunur.
COPY packages/ml/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY packages/ml/src ./src
COPY packages/ml/data ./data

# concrete-cpu ve scikit-learn iki ayri OpenMP calisma zamani yukluyor;
# kapanista cift-init cakisiyor. Gecici susturma, cozum degil.
ENV KMP_DUPLICATE_LIB_OK=TRUE
ENV PORT=8000

# Model ilk istekte degil ACILISTA derlenir; aksi halde ilk ziyaretci
# dakikalarca bekler.
CMD ["sh", "-c", "uvicorn src.server:app --host 0.0.0.0 --port ${PORT}"]
