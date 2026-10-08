# syntax=docker/dockerfile:1.12
# Shared terminal layer: the pinned ttyd binary plus our session scripts.
# Pinned to 1.12, not the brief's 1.7: the 1.7-1.10 frontends fail to expand
# ARG TARGETARCH inside a FROM stage-name (FROM ttyd-${TARGETARCH}), erroring
# "failed to parse stage name \"ttyd-\": invalid reference format". Verified
# locally across 1.7/1.8/1.9/1.10 (all fail) and 1.12/1.17 (both pass).
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
# BuildKit's implicit mkdir for a COPY destination reuses the leaf file's
# --chmod value for the new directory too, so a single 0644 copy leaves
# /etc/ai-trading itself at 0644 (no execute bit): non-root users then get
# "Permission denied" just entering the directory (tmux -f fails to read the
# config). Pre-create the directory at 0755, then re-copy the file at 0644;
# the second COPY does not touch the already-existing directory's mode.
COPY --chmod=0755 tmux.conf /etc/ai-trading/tmux.conf
COPY --chmod=0644 tmux.conf /etc/ai-trading/tmux.conf
