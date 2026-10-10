# Family Desk

The family's own trading desk (Release 2): user-owned, versioned strategies that alert automatically and paper-trade on IBKR paper. Design: [02a](../../plans/subplans/02a-desk-v1-strategies-design.md). Plan and phase status: [02c](../../plans/subplans/02c-desk-v1-implementation-plan.md).

| Path | What |
|---|---|
| `contracts/` | Zod strategy-spec schema (the source of truth), its generated JSON Schema, shared fixtures, and the seeded templates |
| `backend/` | Python 3.12 (uv): Pydantic models generated from the JSON Schema, and the pure strategy core (`ai_trading.core`) |
| `frontend/` | The Desk web app (Phase 4) |

This package never imports another package. Code shared with other ai-trading packages lives in `ai-trading/common/`, and code adapted from an upstream app is copied in with attribution (`ai-trading/AGENTS.md`, "Our Code").

```bash
cd contracts && pnpm install && pnpm typecheck && pnpm test
cd backend && uv sync && uv run ruff check . && uv run pytest -q
```

After changing the schema, run `pnpm generate:json-schema` in `contracts/`, then `scripts/generate-contracts.sh` in `backend/`. The tests fail until both generated files are current.
