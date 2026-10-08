# Task 2: Browser Terminal Images

Part of [01-release-1-hub-plan.md](../01-release-1-hub-plan.md). Read its Global Constraints and Shared Interfaces first.

**Owned paths:** `ai-trading/deploy/upstream/**` only. Never edit `ai-trading/packages/**`. Do not run `git add`, `git commit`, or `git push`.

**Files:**
- Create: `ai-trading/deploy/upstream/terminal/session.sh`, `test-session.sh`, `terminal-entrypoint.sh`, `tmux.conf`, `Dockerfile`
- Create: `ai-trading/deploy/upstream/trading-agents/Dockerfile`
- Create: `ai-trading/deploy/upstream/ai-hedge-fund/Dockerfile`

**Interfaces:**
- Consumes: the upstream TradingAgents image built unmodified from `ai-trading/packages/trading-agents/Dockerfile` (user `appuser`, UID 1000, command `tradingagents`); the ai-hedge-fund source in `ai-trading/packages/ai-hedge-fund` (console script `aihf`).
- Produces:
  - The `terminal-tools` image (scratch) containing `/usr/local/bin/ttyd`, `/usr/local/bin/terminal-entrypoint.sh`, `/usr/local/bin/session.sh`, and `/etc/ai-trading/tmux.conf`.
  - The `ta-terminal` and `ahf-terminal` images, which listen on 7681 under `TTYD_BASE_PATH` and answer requests without the `Cf-Access-Authenticated-User-Email` header with 407.
  - Bake (Task 3) supplies named build contexts `base`, `tools`, and `upstream`.

Facts this task relies on (verified from ttyd 1.7.7 source): `--auth-header` returns 407 when the header is missing, and passes its value to the child as `TTYD_USER`, truncated to 29 characters. `--check-origin` compares the Origin host with the Host header and ignores the scheme. A path without the trailing slash is redirected (302) to the slash form. Debian has no ttyd package, so we download the pinned static binary.

- [ ] **Step 1: Write the failing test `terminal/test-session.sh`**

```sh
#!/bin/sh
# Checks the tmux session names that session.sh derives from the signed-in user.
# Run: sh ai-trading/deploy/upstream/terminal/test-session.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
status=0

check() {
  actual=$(sh "$here/session.sh" --print-name "$1")
  if [ "$actual" = "$2" ]; then
    echo "ok   '$1' -> $actual"
  else
    echo "FAIL '$1' -> $actual (want $2)"
    status=1
  fi
}

check "Toby.Tran@Example.com" "toby-tran-example-com"
check "alice@example.com" "alice-example-com"
check "bob@example.com" "bob-example-com"
check "" "default"
check "---" "default"
check '$(reboot);rm -rf /' "--reboot--rm--rf--"
check "averyveryverylongemailaddress@example.com" "averyveryverylongemailaddress-ex"
exit "$status"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `sh ai-trading/deploy/upstream/terminal/test-session.sh`

Expected: FAIL, because `session.sh` does not exist yet.

- [ ] **Step 3: Write `terminal/session.sh`**

```sh
#!/bin/sh
# Runs APP_COMMAND inside a tmux session named after the signed-in user, so a
# dropped connection (iPad sleep, network blip) reattaches to the running app.
# ttyd passes the Cloudflare Access email in TTYD_USER (truncated to 29 chars).
set -eu

session_name() {
  name=$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | cut -c1-32)
  case "$name" in
    *[a-z0-9]*) printf '%s\n' "$name" ;;
    *) printf '%s\n' default ;;
  esac
}

if [ "${1:-}" = "--print-name" ]; then
  session_name "${2:-}"
  exit 0
fi

: "${APP_COMMAND:?APP_COMMAND is required}"
name=$(session_name "${TTYD_USER:-}")
# Two or more arguments make tmux exec the command directly, without a shell.
exec tmux -f /etc/ai-trading/tmux.conf new-session -A -s "$name" env "$APP_COMMAND"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `sh ai-trading/deploy/upstream/terminal/test-session.sh`

Expected: seven `ok` lines and exit code 0.

- [ ] **Step 5: Write `terminal/tmux.conf`**

```tmux
# Hide tmux: no prefix key, no status bar, no menus. Users only ever see the app.
set -g prefix None
set -g prefix2 None
unbind-key -a -T prefix
unbind-key -T root MouseDown3Pane
unbind-key -T root M-MouseDown3Pane
unbind-key -T root MouseDown3Status
unbind-key -T root MouseDown3StatusLeft
unbind-key -T root MouseDown3StatusRight
set -g status off

# New windows or splits would start a shell; make that impossible.
set -g default-shell /usr/sbin/nologin

# Colors and mouse for the Rich and Textual UIs.
set -g default-terminal "tmux-256color"
set -ga terminal-features ",xterm-256color:RGB"
set -g mouse on
set -g history-limit 20000
set -g escape-time 10
set-environment -g COLORTERM truecolor
```

- [ ] **Step 6: Write `terminal/terminal-entrypoint.sh`**

```sh
#!/bin/sh
# Starts ttyd for one upstream terminal app.
#   APP_COMMAND       command run inside the per-user tmux session (required)
#   TTYD_BASE_PATH    URL prefix served by ttyd, for example /u/tradingagents (required)
#   TTYD_AUTH_HEADER  request header carrying the signed-in user (optional)
set -eu
: "${APP_COMMAND:?APP_COMMAND is required}"
: "${TTYD_BASE_PATH:?TTYD_BASE_PATH is required}"
set -- --port 7681 --writable --check-origin --base-path "$TTYD_BASE_PATH" --terminal-type xterm-256color
if [ -n "${TTYD_AUTH_HEADER:-}" ]; then
  set -- "$@" --auth-header "$TTYD_AUTH_HEADER"
fi
exec /usr/local/bin/ttyd "$@" /usr/local/bin/session.sh
```

- [ ] **Step 7: Write `terminal/Dockerfile` (the shared `terminal-tools` layer)**

```dockerfile
# syntax=docker/dockerfile:1.7
# Shared terminal layer: the pinned ttyd binary plus our session scripts.
ARG TARGETARCH

FROM scratch AS ttyd-amd64
ADD --checksum=sha256:8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55 \
    https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 /ttyd

FROM scratch AS ttyd-arm64
ADD --checksum=sha256:b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165 \
    https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.aarch64 /ttyd

FROM ttyd-${TARGETARCH} AS ttyd

FROM scratch
COPY --from=ttyd --chmod=0755 /ttyd /usr/local/bin/ttyd
COPY --chmod=0755 terminal-entrypoint.sh session.sh /usr/local/bin/
COPY --chmod=0644 tmux.conf /etc/ai-trading/tmux.conf
```

- [ ] **Step 8: Write `trading-agents/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
# TradingAgents in a browser terminal. "base" is the upstream image built
# unmodified from ai-trading/packages/trading-agents; "tools" is the terminal layer.
FROM base
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux ncurses-term \
 && rm -rf /var/lib/apt/lists/*
COPY --from=tools / /
ENV APP_COMMAND=tradingagents \
    TTYD_BASE_PATH=/u/tradingagents \
    TTYD_AUTH_HEADER=Cf-Access-Authenticated-User-Email
USER appuser
EXPOSE 7681
ENTRYPOINT ["/usr/local/bin/terminal-entrypoint.sh"]
CMD []
```

- [ ] **Step 9: Write `ai-hedge-fund/Dockerfile`**

```dockerfile
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
```

- [ ] **Step 10: Build the images (from the repository root; needs Task 0's buildx)**

```bash
docker buildx build --load -t ai-trading/terminal-tools:check ai-trading/deploy/upstream/terminal
docker buildx build --load -t ai-trading/ta-upstream:check ai-trading/packages/trading-agents
docker buildx build --load -t ai-trading/ta-terminal:check \
  --build-context base=docker-image://ai-trading/ta-upstream:check \
  --build-context tools=docker-image://ai-trading/terminal-tools:check \
  ai-trading/deploy/upstream/trading-agents
docker buildx build --load -t ai-trading/ahf-terminal:check \
  --build-context upstream=ai-trading/packages/ai-hedge-fund \
  --build-context tools=docker-image://ai-trading/terminal-tools:check \
  ai-trading/deploy/upstream/ai-hedge-fund
```

Expected: four successful builds. If the `docker-image://` contexts cannot find local images, wait for Task 3's bake file and build with `docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load ta-terminal ahf-terminal`. Report which path you used.

- [ ] **Step 11: Verify the CLIs, tmux, and ttyd**

```bash
docker run --rm --entrypoint tradingagents ai-trading/ta-terminal:check --help >/dev/null && echo "ok tradingagents --help"
docker run --rm --entrypoint aihf ai-trading/ahf-terminal:check --help >/dev/null && echo "ok aihf --help"
for image in ai-trading/ta-terminal:check ai-trading/ahf-terminal:check; do
  docker run --rm --entrypoint sh "$image" -c '
    set -e
    tmux -f /etc/ai-trading/tmux.conf new-session -d -s probe env sleep 30
    sleep 1
    tmux has-session -t probe
    test "$(tmux show-options -gv status)" = off' && echo "ok tmux probe $image"
done
docker run -d --name ta-check -p 127.0.0.1:17681:7681 ai-trading/ta-terminal:check
sleep 2
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:17681/u/tradingagents/
curl -s -o /dev/null -w '%{http_code}\n' -H 'Cf-Access-Authenticated-User-Email: check@example.test' http://127.0.0.1:17681/u/tradingagents/
docker rm -f ta-check
```

Expected: `ok tradingagents --help`, `ok aihf --help`, two `ok tmux probe` lines, then `407` and `200`.

If the tmux probe fails because tmux ran `env sleep 30` through `default-shell`, stop and report it. The documented fallback is to set `default-shell /bin/sh` and rely on the unbound keys; do not apply it silently.
