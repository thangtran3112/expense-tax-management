FROM node:24-bookworm-slim AS build

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/contracts/src ./packages/contracts/src
COPY packages/contracts/generated ./packages/contracts/generated
COPY services/workflow-worker/package.json services/workflow-worker/tsconfig.json ./services/workflow-worker/
COPY services/workflow-worker/src ./services/workflow-worker/src

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @expense-tax/contracts build
RUN pnpm --filter @expense-tax/workflow-worker build

FROM node:24-bookworm-slim AS runtime

WORKDIR /workspace
RUN groupadd --system app && useradd --system --gid app --home-dir /nonexistent app

COPY --from=build --chown=app:app /workspace/node_modules ./node_modules
COPY --from=build --chown=app:app /workspace/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build --chown=app:app /workspace/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=app:app /workspace/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=app:app /workspace/services/workflow-worker/package.json ./services/workflow-worker/package.json
COPY --from=build --chown=app:app /workspace/services/workflow-worker/node_modules ./services/workflow-worker/node_modules
COPY --from=build --chown=app:app /workspace/services/workflow-worker/dist ./services/workflow-worker/dist

WORKDIR /workspace/services/workflow-worker
USER app
CMD ["node", "dist/worker.js"]
