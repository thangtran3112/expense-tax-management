FROM node:24-alpine AS build

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/contracts/src ./packages/contracts/src
COPY packages/contracts/generated ./packages/contracts/generated
COPY packages/gateway-policy/package.json packages/gateway-policy/tsconfig.json ./packages/gateway-policy/
COPY packages/gateway-policy/src ./packages/gateway-policy/src
COPY services/app-api/package.json services/app-api/tsconfig.json ./services/app-api/
COPY services/app-api/src ./services/app-api/src

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @expense-tax/contracts build
RUN pnpm --filter @expense-tax/gateway-policy build
RUN pnpm --filter @expense-tax/app-api build

FROM node:24-alpine AS runtime

WORKDIR /workspace
RUN addgroup -S app && adduser -S app -G app

COPY --from=build --chown=app:app /workspace/node_modules ./node_modules
COPY --from=build --chown=app:app /workspace/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build --chown=app:app /workspace/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=app:app /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=app:app /workspace/packages/gateway-policy/package.json ./packages/gateway-policy/package.json
COPY --from=build --chown=app:app /workspace/packages/gateway-policy/dist ./packages/gateway-policy/dist
COPY --from=build --chown=app:app /workspace/services/app-api/package.json ./services/app-api/package.json
COPY --from=build --chown=app:app /workspace/services/app-api/node_modules ./services/app-api/node_modules
COPY --from=build --chown=app:app /workspace/services/app-api/dist ./services/app-api/dist

RUN mkdir -p /tmp/expense_tax_storage /tmp/expense_tax_inbound_challenges && \
    chown app:app /tmp/expense_tax_storage /tmp/expense_tax_inbound_challenges

WORKDIR /workspace/services/app-api
USER app
EXPOSE 8100
CMD ["node", "dist/server.js"]
