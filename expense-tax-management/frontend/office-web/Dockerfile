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
COPY frontend/office-web/package.json frontend/office-web/tsconfig.json frontend/office-web/next.config.ts frontend/office-web/eslint.config.mjs ./frontend/office-web/
COPY frontend/office-web/src ./frontend/office-web/src
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @expense-tax/contracts build
RUN pnpm --filter @expense-tax/office-web build
FROM node:24-alpine AS runtime
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /workspace/frontend/office-web/.next/standalone ./
COPY --from=build --chown=app:app /workspace/frontend/office-web/.next/static ./frontend/office-web/.next/static
USER app
ENV NODE_ENV=production PORT=7302 HOSTNAME=0.0.0.0
EXPOSE 7302
CMD ["node", "frontend/office-web/server.js"]
