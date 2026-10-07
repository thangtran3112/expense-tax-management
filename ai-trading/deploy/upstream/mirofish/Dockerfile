# syntax=docker/dockerfile:1.7
# MiroFish backend-only image. "upstream" is the unmodified package source
# (ai-trading/packages/mirofish/backend), copied in as-is and built with uv
# from its pinned lock. No Node/Vite/npm: the Vue frontend ships separately
# as static assets for the dedicated GCS bucket (see mirofish-frontend).
ARG PYTHON_IMAGE=python:3.11-slim-trixie@sha256:6f31d6e9ba2b0a787a3f81c37b004155b87b9efa1b771182bd550c1615745be5

FROM ${PYTHON_IMAGE} AS build
COPY --from=ghcr.io/astral-sh/uv:0.9.26 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
WORKDIR /src
# camel-ai pulls in psutil==5.9.8, which has no prebuilt wheel for this arch
# and must compile from source; gcc/python3-dev stay in this build stage only,
# not the runtime image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc python3-dev \
 && rm -rf /var/lib/apt/lists/*
# Installs exactly what the upstream lock pins; a stale lock fails the build loudly.
COPY --from=upstream pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY --from=upstream . .
RUN uv sync --frozen --no-dev

FROM ${PYTHON_IMAGE}
COPY --from=build /src /app
# app/utils/locale.py walks up to /locales (a sibling of "backend" in the
# upstream repo root, outside this image's pinned "backend" context); copied
# in unmodified from its own named context, see docker-bake.hcl.
COPY --from=locales . /locales
RUN useradd --create-home --shell /usr/sbin/nologin mirofish \
 && mkdir -p /app/uploads/simulations /app/logs \
 && chown -R mirofish:mirofish /app/uploads /app/logs
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    FLASK_HOST=0.0.0.0 \
    FLASK_PORT=5001
USER mirofish
WORKDIR /app
EXPOSE 5001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5001/health', timeout=4)"
ENTRYPOINT ["python", "run.py"]
