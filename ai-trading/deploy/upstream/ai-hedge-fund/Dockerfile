# syntax=docker/dockerfile:1.7
# ai-hedge-fund in a browser terminal. "upstream" is the unmodified package
# source (ai-trading/packages/ai-hedge-fund); "tools" is the terminal layer.
ARG PYTHON_IMAGE=python:3.11-slim-trixie@sha256:6f31d6e9ba2b0a787a3f81c37b004155b87b9efa1b771182bd550c1615745be5

FROM ${PYTHON_IMAGE} AS build
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
RUN pip install poetry==1.8.5
WORKDIR /src
COPY --from=upstream . .
# Install exactly what the upstream lock pins; a stale lock fails the build loudly.
RUN poetry export --only main --format requirements.txt --output /tmp/requirements.txt \
 && python -m venv /opt/venv \
 && /opt/venv/bin/pip install --require-hashes -r /tmp/requirements.txt \
 && /opt/venv/bin/pip install --no-deps .

FROM ${PYTHON_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux ncurses-term \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --shell /usr/sbin/nologin app \
 && install -d -o app -g app -m 0700 /home/app/.hedge-fund
COPY --from=build /opt/venv /opt/venv
COPY --from=tools / /
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    APP_COMMAND=aihf \
    TTYD_BASE_PATH=/u/ai-hedge-fund \
    TTYD_AUTH_HEADER=Cf-Access-Authenticated-User-Email
USER app
WORKDIR /home/app
EXPOSE 7681
ENTRYPOINT ["/usr/local/bin/terminal-entrypoint.sh"]
