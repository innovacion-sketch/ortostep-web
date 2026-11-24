# Programa de extracción ORTOSTEP (para Easypanel u otro servidor con Docker).
# En Easypanel: App desde GitHub, ruta de construcción "/worker", Dockerfile "Dockerfile".
# No expone puertos. Variables de entorno: SUPABASE_URL, SUPABASE_SECRET_KEY (y opcionales).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ORTOSTEP_CACHE=/cache

# Bibliotecas que necesitan MediaPipe y OpenCV en Linux.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libegl1 libgles2 libportaudio2 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ortostep_worker ./ortostep_worker
COPY tests ./tests

# Pruebas y descarga del modelo de pose durante la construcción:
# si algo falla, el despliegue falla en lugar de arrancar roto.
RUN python tests/test_basico.py \
 && python -c "from ortostep_worker import marcha; marcha.ruta_modelo('/cache')"

CMD ["python", "-m", "ortostep_worker", "vigilar"]
