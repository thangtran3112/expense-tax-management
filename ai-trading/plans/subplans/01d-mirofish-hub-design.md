# Release 1 Design Addendum: Upstream MiroFish, Static Original UI

Status: Approved by owner on 2026-10-05. The previous custom-MiroFish-UI approach is dropped. This addendum extends [the Trading Hub design](01-release-1-hub-design.md), pairs with [static frontend hosting](01e-static-hub-gcs-design.md), and follows [upstream compatibility and sync rules](01f-upstream-sync-skills-design.md). MiroFish is the fourth unmodified upstream app; Family Desk is the planned fifth app in release 2.

## What users get

Let both family users try the **original** MiroFish interface and engine. MiroFish's README says financial prediction is “coming soon”; label it “Experimental simulation lab,” not a stocks/futures scanner, broker, or trading backtester. Its Vue UI already implements upload → graph → simulation → report → interview. Rebuilding its roughly 20,000-line interface for a non-trading tool would delay the MVP without adding family-specific value. Both users share this experimental MiroFish instance's projects; separate installations need another design if isolation becomes necessary.

## Upstream boundary and server

- **Source stays unmodified.** Add `ai-trading/packages/mirofish` as a submodule of `https://github.com/666ghj/MiroFish`, initially pinned to `7657031ac01184afe2cb220f5ee3545573b5e843`. Dependabot updates its pointer with the other upstream submodules. Build its original `frontend/` with its unchanged `npm run build` into static GCS assets. `VITE_API_BASE_URL=https://mirofish.tobytran.dev` is a build-time setting; it prevents the upstream axios client from calling the browser user's `localhost:5001`. No MiroFish Vue or Flask source files are edited or vendored into Family Desk.
- Build a separate backend-only deployment image using an **external** Dockerfile that installs from the unmodified `backend/pyproject.toml` and `backend/uv.lock` (`uv sync --frozen --no-dev`) and starts the original `backend/run.py`. Do not include Node/Vite/npm dependencies in the VPS image. Keep **one Flask process**, since upstream task polling uses in-memory state. Keep original `backend/uploads/` on a dedicated VPS volume for project JSON, reports, and simulation SQLite files.
- Serve the original Vue UI from a GCS bucket at `mirofish.tobytran.dev`, via the same Cloudflare static edge pattern as the hub. Requests to that hostname's `/api/*` route to the VPS Flask backend, preserving origin and upload bodies. Nothing on the VPS publishes Flask's port 5001. The upstream Flask app has CORS `*` and no auth; a VPS gateway must verify a Clerk-issued, server-signed family session on **every API request**. The static UI contains no secrets or user data: GCS asset URLs are publicly readable even though the custom hostname redirects unsigned-in visitors to the hub login. This redirect is UX, **not** the API security boundary.
- Give Flask its own Compose network, joined only by the authenticated gateway, with no host ports or shared mounts. Start with 4 GB memory, 2 CPUs, and 512 PIDs; verify a small real simulation before activation. The backend may use its upstream development-mode single-process server for the initial two-person trial, behind the gateway. No new GCP application compute.
- The upstream is AGPL-3.0. Show links to the exact pinned source revision and its LICENSE on the MiroFish hub page. Recheck obligations before modifying/distributing any part of the upstream program.

## Client-only hub UI

- Add category “Simulation lab” and `/apps/mirofish` inside the hub's existing search/filterable registry and design system. Keep Family Desk as planned fifth card. The route describes the upstream simulator and links to its original Vue app at `mirofish.tobytran.dev` after activation; the hub itself remains a static Next.js export as specified in [the GCS design](01e-static-hub-gcs-design.md). The original Vue client performs uploads, polling, stop actions, reports, and interviews through its same-origin `/api/*` route.
- Before activation, the card says “Experimental · Setup required,” explains the two keys and Zep free tier, links exact source and license, and does not offer a launch link. Activation of the unchanged Vue app is a reviewed change once auth, keys, and an end-to-end run are verified. No trading claims or invented market data.

## Zep and model usage

MiroFish uses Zep Cloud as **mandatory external temporal graph memory**: it extracts entities and relationships from source documents, stores/upgrades agent memories during simulation, and searches those graphs for reports. Project files and SQLite state remain on the VPS, but uploaded text and derived graph information can leave the VPS for Zep. The owner approved Zep Cloud for public/non-sensitive experiments, initially on its free plan: [10,000 credits/month, no rollover, variable rate limits](https://www.getzep.com/pricing). Paid Flex starts at $125/month and is not enabled in this release. When the free allocation ends, show the upstream error and pause new simulations; never enable auto-top-up without another decision.

- Backend-only credentials: `ZEP_API_KEY` and `LLM_API_KEY` are required at startup. Optional `LLM_BASE_URL` and `LLM_MODEL_NAME` select the model; default rounds start at upstream's 10 (`OASIS_DEFAULT_MAX_ROUNDS`) and the UI encourages smaller trials. High agent counts and rounds can cause many LLM calls, independent of Zep credits.
- The user already has OpenAI and Anthropic keys. MiroFish uses `openai.OpenAI(base_url=...)`: an **OpenAI** key works directly, while an Anthropic key needs an OpenAI-compatible gateway. Use the existing OpenAI key from the approved family configuration source, server-side only. Do not add a gateway just to use Anthropic in this trial.
- The approved Firestore `family-config` design supersedes the transitional ai-trading Secret Manager bundle. Once the other session's handoff and CLI exist, configure `apps/ai-trading/profiles/mirofish` and render runtime credentials from it. Do not create another Secret Manager bundle or real `.env` file inside this repository. Missing keys do not break the three existing upstream apps: the MiroFish service stays disabled until the profile is ready.

## Verification and activation

1. CI builds the original Vue assets and the backend-only image from the same pinned submodule. With throwaway keys, probe backend `/health` and static build integrity; **do not** run paid Zep or LLM simulations in CI. If startup calls remote services, report that and keep the image build check, rather than claiming a health check passed.
2. Local routing test loads a Vue page with `VITE_API_BASE_URL` targeting a gateway that returns a recorded fake `/api/graph` response; verify no browser request goes to localhost:5001. An unsigned-in user cannot reach Flask via either the custom or tunnel-origin hostname; direct GCS asset URLs remain public by design. Flask project files remain in the dedicated volume, not GCS.
3. Live activation requires: both Firestore-sourced keys, Zep free plan, a working Clerk gate for the Vue page and API, one small end-to-end simulation, source/license links, VPS memory/disk checks, and a rollback to the previous deployment. Until then, do not expose `mirofish.tobytran.dev` publicly.

## Non-goals

No local replacement for Zep, no direct Anthropic integration, no custom MiroFish UI, no GCP application backend, no live portfolio or IBKR integration, and no modification of the upstream MiroFish package.
