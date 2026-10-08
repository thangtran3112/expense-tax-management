# Phase 0b: App Shell Evaluation

Status: Done (2026-10-04)

Question: should the app start from a full-stack agent harness or a frontend protocol instead of a hand-built shell?

Method: the same read-only review as Phase 0, plus a documentation fact-check of candidate libraries through Context7 and the GitHub API. Raw notes are in `ai-trading/temp/eval/{deer-flow,ag-ui,components}.md` (local only).

## Do the Phase 0 repos ship a web app?

| Repo | Web app |
|---|---|
| TradingAgents | No. Typer CLI and a static HTML report. |
| ai-hedge-fund | Not anymore. Release 2.0.0 deleted its FastAPI + React app; it remains at commit `6c41ae8` under `app/`. The current UI is a terminal TUI. |
| Vibe-Trading | Yes: React + Vite (not Next.js), Tailwind, ECharts, with a FastAPI + MCP backend. One shared API key, no user accounts. |

## Checkouts

| Package | Path | Commit | License | Activity (last 90 days) |
|---|---|---|---|---|
| deer-flow | `packages/deer-flow` | `ee44d1e` (2026-10-04) | MIT | 1,293 commits, 258 authors |
| AG-UI | `packages/ag-ui` | `97f789c` (2026-10-03) | MIT | 1,671 commits, 65 authors |

Both are blobless clones (`--filter=blob:none`). `packages/ag-ui` contains Git LFS pointer files and git-lfs is not installed, so run git commands there with `-c filter.lfs.process= -c filter.lfs.smudge= -c filter.lfs.required=false`.

## deer-flow

Stack: Next.js 16, Vercel AI SDK 6, Vercel AI Elements components, and the LangGraph SDK protocol to a FastAPI + open-source LangGraph backend (no LangGraph Platform license needed). SQLite by default, Postgres optional.

Built in: local, OIDC, and personal-access-token auth with admin and user roles; crash-recoverable scheduled tasks with notification delivery; Slack, Telegram, and other chat-channel bots; sub-agents, skills, sandboxed code execution, and memory.

Missing: per-user cost budgets (only a per-run token budget and per-model rate limits), an alerts inbox, and anything finance-specific.

Verdict: borrow components; do not fork. About 1,800 backend files and roughly 14 upstream commits a day make a fork a permanent merge job, and we would inherit chat bots, a plugin ABI, and sandboxed code execution we do not need.

Borrow:

- `backend/app/scheduler/service.py` and `notification_delivery.py`: lease-based scheduled tasks with notification delivery.
- `backend/app/gateway/auth/` (`local_provider.py`, `password.py`, `jwt.py`, `session_cookie.py`, `repositories/`): two-role local auth.
- `frontend/src/components/ai-elements/`: Vercel AI Elements chat components. Install them from the AI SDK registry instead of copying.
- `config.example.yaml`: model-provider examples, including DeepSeek and a generic `base_url`.

## AG-UI

Protocol 1.0 shipped on 2026-09-17 (`ag-ui-protocol` 1.0.0 on PyPI; `@ag-ui/core` and `@ag-ui/client` 1.0.1 on npm). It defines 31 event types over SSE or protobuf: messages, tool calls and results, state snapshots and JSON-Patch deltas, interrupts for human-in-the-loop, and token usage. Auth, thread persistence, and stream resume are out of scope.

SDKs: Python, TypeScript, and .NET, plus community C++, Dart, Go, Java, Kotlin, Ruby, and Rust. The Kotlin SDK includes a SwiftUI chat example, which is a path for a future iOS client. Integrations include PydanticAI, LangGraph, Agno, the Claude Agent SDK, and the Vercel AI SDK.

CopilotKit is the reference React client, but production use needs a Node `CopilotRuntime` route; its own docs call direct browser-to-AG-UI a prototype path.

Risks: single-vendor governance (the CopilotKit team); pre-1.0 compatibility shims expire on 2027-09-17 (`DEPRECATIONS.md`); version skew between integrations and clients.

Verdict: adopt the protocol between our Python backend and our clients. Skip CopilotKit.

## Component fact-check (2026-10-04)

| Component | Verified facts relevant to us |
|---|---|
| PydanticAI 2.54 (MIT) | `AGUIAdapter` serves an agent as an AG-UI endpoint inside FastAPI; `UsageLimits` caps requests and tokens per run; Anthropic, OpenAI, OpenAI-compatible, and vLLM providers; MCP client; Temporal durable execution. |
| assistant-ui 0.15 (MIT) | React chat UI with an AG-UI runtime (`useAgUiRuntime`) and tool-result UI rendering; Next.js first. |
| LiteLLM proxy 1.104 (MIT outside `enterprise/`) | Per-user, per-key, and per-team budgets (`max_budget`, `budget_duration`) and spend logs in the open-source proxy; requires Postgres. |
| LibreChat 0.8 (MIT) | Per-user token balance, MCP (streamable HTTP recommended for multi-user), local/OIDC/LDAP auth, artifacts panel; requires MongoDB plus a RAG service. |
| Agno 3.1 (Apache-2.0) | AgentOS FastAPI runtime with native AG-UI and session storage; no cost budgets; `agent-ui` dormant since 2026-05. |
| Open WebUI | Custom BSD-3 license with a branding clause (fine under 50 users); Python tools run in-process; no built-in budgets. |

## Conclusions (recommendation pending approval)

1. No harness becomes the app base. deer-flow joins Vibe-Trading as a parts bin.
2. AG-UI is the right seam between the backend and clients: web now, iOS later, independent of the agent framework.
3. Lowest-glue own stack: FastAPI + PydanticAI (agent, tools, per-run limits, AG-UI output) with Next.js + assistant-ui (AG-UI input, tool-result components). Per-user monthly budgets come from recorded usage; add the LiteLLM proxy only if a shared gateway becomes useful.
