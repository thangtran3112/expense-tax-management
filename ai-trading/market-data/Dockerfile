# syntax=docker/dockerfile:1.7
ARG PYTHON_IMAGE=python:3.11-slim-trixie@sha256:6f31d6e9ba2b0a787a3f81c37b004155b87b9efa1b771182bd550c1615745be5
FROM ${PYTHON_IMAGE}
RUN useradd --create-home --shell /usr/sbin/nologin app
WORKDIR /app
COPY server.py metrics.py errors.py sec.py alpaca.py ./
USER app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/healthz', timeout=4)"
CMD ["python", "server.py"]
