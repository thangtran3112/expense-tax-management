# syntax=docker/dockerfile:1.7
# MiroFish's unmodified Vue frontend, built into static assets for the
# dedicated mirofish GCS bucket. "upstream" is the unmodified package source
# (ai-trading/packages/mirofish/frontend). No source or Vite config is
# edited; VITE_API_BASE_URL is Vite's own build-time env mechanism.
FROM node:24-slim AS build
ARG VITE_API_BASE_URL
WORKDIR /src
COPY --from=upstream package.json package-lock.json ./
RUN npm ci
COPY --from=upstream . .
# src/i18n/index.js resolves three directories above its own file to a
# sibling "locales" dir at the mirofish repo root (outside the "frontend"
# subtree, same layout the mirofish-backend target pins separately); copied
# in unmodified from its own named context, see docker-bake.hcl.
COPY --from=locales . /locales
RUN set -eu; \
    if [ -z "$VITE_API_BASE_URL" ]; then \
      echo "VITE_API_BASE_URL must be set and non-empty" >&2; exit 1; \
    fi; \
    VITE_API_BASE_URL="$VITE_API_BASE_URL" npm run build; \
    if grep -rqF "localhost:5001" dist; then \
      echo "built assets still reference localhost:5001; VITE_API_BASE_URL did not take effect" >&2; \
      exit 1; \
    fi

FROM scratch AS export
COPY --from=build /src/dist /
