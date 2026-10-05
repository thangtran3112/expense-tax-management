# opencode Project Context

This directory contains project-specific rules and agents for opencode.

## Current Architecture

- App API and Foundry are Fastify/Zod/Kysely services.
- Python is worker-only and cannot access App/Foundry PostgreSQL.
- Zod contracts are canonical; generated files are read-only.
- Every customer resource requires explicit Personal/business scope authorization; tenant role alone never grants profile access.
- Foundry tenant tokens are always invalid.
- Runtime and migration database credentials are separate.
- Transitional `expense-service` and `frontend/web` remain untouched until their owning cutover phases.
- Frontend mockup gates remain application-specific.

## Files

- `rules/expense-service.rules` - transitional Python worker and legacy service boundaries
- `rules/frontend.rules` - transitional frontend boundaries and application-specific mockup gates

Completed Phase 0I builder instructions were removed; implementation history remains in git.

## Usage

opencode loads `AGENTS.md` and `.opencode/rules/*.rules` through project configuration. Agent and rule changes require restarting opencode before use.
