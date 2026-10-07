FROM node:24-alpine AS build
WORKDIR /workspace
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
RUN test -n "$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" || (echo "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required" >&2 && exit 1)
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
# Web session wiring design (2026-10-06): defaults to the production App
# API origin, so no GitHub variable is needed; local/dev overrides this
# build arg to point at a loopback or other App API origin.
ARG NEXT_PUBLIC_APP_API_URL=https://expense-api.tobytran.dev
ENV NEXT_PUBLIC_APP_API_URL=$NEXT_PUBLIC_APP_API_URL
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/contracts/src ./packages/contracts/src
COPY packages/contracts/generated ./packages/contracts/generated
COPY frontend/capture-web/package.json frontend/capture-web/tsconfig.json frontend/capture-web/next.config.ts frontend/capture-web/eslint.config.mjs ./frontend/capture-web/
COPY frontend/capture-web/src ./frontend/capture-web/src
COPY frontend/capture-web/public ./frontend/capture-web/public
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @expense-tax/contracts build
RUN pnpm --filter @expense-tax/capture-web build

FROM node:24-alpine AS runtime
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /workspace/frontend/capture-web/.next/standalone ./
COPY --from=build --chown=app:app /workspace/frontend/capture-web/.next/static ./frontend/capture-web/.next/static
COPY --from=build --chown=app:app /workspace/frontend/capture-web/public ./frontend/capture-web/public
USER app
ENV NODE_ENV=production PORT=7301 HOSTNAME=0.0.0.0
EXPOSE 7301
CMD ["node", "frontend/capture-web/server.js"]
