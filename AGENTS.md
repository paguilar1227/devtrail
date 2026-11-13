# AGENTS.md — DevTrail

Guidance for AI coding agents (and people) working in this repository. Path-scoped rules live in `.claude/rules/`. Claude Code loads them automatically; other agents should read the matching file before working in that subtree.

| Subtree you're working in | Read (in addition to this file) |
|---|---|
| `backend/**` | `.claude/rules/backend.md` (service layer, MCP tools, project membership, search/RAG, backend tests) |
| `migrations/**` or `backend/src/db/**` | `.claude/rules/schema.md` (migrations, pgvector, the HNSW constraint) |
| `backend/src/providers/**` or `backend/src/capture/**` | `.claude/rules/llm.md` (JSON parsing, token budgets, model IDs, multimodal, URL fetchers) |
| `frontend/**` | `.claude/rules/frontend.md` (drawer composition, rows, Playwright setup) |

## Check the code first

Before trusting this file, the rules or any notes: **verify against the current code**. Cheap checks:

- `git log --oneline -20`: what changed recently
- `find backend/src -type f -name '*.ts' | sort` and `find frontend/src -type f -name '*.ts*' | sort`
- `ls migrations/`: the current schema
- `cat backend/package.json frontend/package.json`: current dependencies
- `GET /health` on a running server confirms what is deployed

If a doc names a file, function or entity that no longer exists, the doc is stale: fix it. If the doc and the code disagree, the code wins.

## What DevTrail is

A shared workspace where people and AI agents track work, with hybrid semantic and entity-graph search across everything in it. One owner per deployment; no multi-tenancy.

- **Projects** group everything else.
- **Content items** are documents (uploaded files, URLs) and notes (written text). Both are chunked and embedded for search.
- **Todos** have optional project membership, recursive subtasks and comments.
- **Sessions** are workspaces an agent or person creates or resumes by a stable key. They own their notes, documents and todos, and carry a handoff: summary, decisions and next steps.
- **Timelines** are durable project and session histories written by database triggers, so every change is recorded no matter which client made it.
- **Entities + chunk_entities** form a graph over the corpus, extracted at ingest and used to expand retrieval along entity edges.

## Stack

| Layer | Tech |
|------|------|
| API | Hono on Node 20, served by `@hono/node-server` |
| Web UI | Vite + React, hand-rolled CSS in `frontend/src/styles.css`, built into `frontend/dist` and served by Hono |
| MCP | `@modelcontextprotocol/sdk` over Streamable HTTP, mounted at `/mcp` |
| Database | PostgreSQL + pgvector (3072-dim, sequential scan, no HNSW) |
| Blob storage | Azure Blob Storage (Azurite locally) |
| Container | Docker; the reference deployment is Azure Container Apps |
| iOS app | Capacitor 8 shell (`frontend/ios/`, SPM, no CocoaPods) wrapping the same Vite bundle |

## Models (see `backend/src/server.ts`)

| Role | Provider | Model |
|------|----------|-------|
| Embeddings | Gemini | `gemini-embedding-2-preview` (3072d, multimodal) |
| Metadata for audio and video (transcripts) | Gemini | `gemini-3-flash-preview` |
| Metadata for text, images (OCR) and PDFs; entity extraction | Anthropic | `claude-haiku-4-5-20251001` |
| Query depth classifier | Anthropic | `claude-haiku-4-5-20251001` |
| RAG fast path (default) | Azure OpenAI / Foundry chat completions | `gpt-5-4` |
| RAG thorough path (opt-in) | Azure OpenAI / Foundry Responses API | `gpt-5-4-pro` |

`LLM_PROVIDER=stub` replaces every model call with deterministic fakes. Local development and the test suites use it.

## Code layout

```
backend/                  # Hono API + MCP server (Node 20)
├── src/                  # see .claude/rules/backend.md for the detailed tree
├── tests/                # unit + integration (PGlite, mocked providers)
└── package.json
frontend/                 # Vite + React web client (also the iOS app)
├── src/
├── tests/e2e/            # Playwright workflow suite
└── package.json
shared/                   # @devtrail/shared — Zod schemas + TS types on the wire
└── src/schemas.ts        # single source of truth for request/response shapes
migrations/               # SQL migrations, applied at backend startup
infra/                    # Bicep for the Azure reference deployment
ci/                       # Dagger module: the CI gate
scripts/                  # dev stack, deploy, live checks, diagnostics
docs/                     # architecture, deployment, CI, testing, diagrams
.claude/rules/            # path-scoped rules
```

The root `package.json` is a thin script delegator.

## HTTP surface

| Path | For | Auth |
|---|---|---|
| `/api/v1/*` | REST clients and the web app | `Authorization: Bearer <DEVTRAIL_API_KEY>` only |
| `/api/v1/openapi.json`, `/api/v1/docs` | anyone | public; Swagger's **Authorize** takes the Bearer key |
| `/mcp` | MCP clients | Bearer; also `?key=` when `MCP_ALLOW_URL_KEY=true` |
| `/api/auth/token` | browsers behind Azure Easy Auth | exists only when `AUTH_MODE=easyauth` |
| `/health` | probes | public |

Every other `/api/*` path answers JSON 404; everything else serves the web app. In the default `AUTH_MODE=api-key` the web app shows a sign-in screen that asks for the API key. Keys are compared in constant time (`requireBearerKey` in `backend/src/app.ts`).

Routes are `app.openapi(createRoute(...))` definitions with Zod request and response schemas, so the spec cannot drift from the handlers. Conventions:

- Path parameters are `{id}` (and `{cid}` for comments, `{name}` for tags).
- List filters: `?project_id=` (`null` selects items without a project), `?tags=a,b`, `?pinned=`, `?limit=`.
- Soft delete by default (`archived = true`); `?hard=true` deletes permanently. `/restore`, `/pin` and `/unpin` are `POST` sub-routes.
- Errors are `{ "error": string }`.

Route groups (see `backend/src/app.ts` and `backend/src/workspace-routes.ts`): projects, content (plus `/from-url`, `/bulk`, `/{id}/status`, `/{id}/retry`, `/{id}/reprocess`, `/{id}/replace`, `/{id}/edit-body`), todos (plus `/bulk`, `/reorder`, comments), tags, activity, stats, search (`/search`, `/find-mentions`, `/rag`), sessions (plus `/{id}/context`, `/{id}/timeline`), project timelines and diagnostics.

Content ingest is asynchronous: `POST /content` and `/from-url` return **202 + `{id, processing_status: 'pending'}`**. Poll `GET /content/{id}/status` until `ready` or `failed`.

The MCP server exposes 32 tools that mirror the REST surface (`backend/src/mcp/server.ts`, `backend/src/mcp/session-tools.ts`). Its `INSTRUCTIONS` string is applied automatically by MCP clients that support server instructions.

## Development workflow

### Local cycle

```bash
npm run dev:up        # Postgres + Azurite + backend + frontend, stub mode
make ci               # quick native gate: typecheck + unit + build
make e2e              # Playwright workflow suite against a local stack
dagger call ci        # the full CI gate (typecheck, unit, build, security)
```

`make bootstrap` installs dependencies, builds `@devtrail/shared` and installs the git hooks.

### CI

The Dagger module in `ci/` is the gate. Lefthook runs `dagger call ci` on pre-push (feature branches) and gitleaks on pre-commit; GitHub Actions runs the same `dagger call ci` on pushes to `main` and on manual dispatch. The Playwright suite is not a Dagger gate yet; run `make e2e` before merging UI changes. See [docs/ci.md](docs/ci.md).

`deploy.yml` deploys to Azure on pushes to `main` only when the repository variables `ACR_NAME`, `AZURE_RESOURCE_GROUP` and `CONTAINER_APP_NAME` are set. See [docs/deploy-azure.md](docs/deploy-azure.md).

### iOS app (Capacitor shell)

The web `frontend/` is the iOS app: Capacitor 8 wraps the same `dist/` bundle in a WKWebView. `apiOrigin()` (in `frontend/src/lib/nativeConfig.ts`) returns `''` outside Capacitor, so web requests stay same-origin. Native-only pieces: `nativeConfig.ts` (stored server origin), `components/ConnectScreen.tsx` (server URL + API key, verified against `/api/v1/stats` before it is stored) and the native branches in `lib/api.ts`.

```bash
cd frontend && npm run build && npx cap sync ios
cd ios/App && xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17e' -derivedDataPath ./DerivedData build
xcrun simctl install booted DerivedData/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch booted com.example.devtrail
```

Change the bundle identifier (`com.example.devtrail`) to one you own before shipping a build. First launch asks for the server URL and API key (local dev: `http://localhost:3001` and the `DEVTRAIL_API_KEY` from `backend/.env`). `make ios-smoke` runs a local simulator smoke test; see [docs/ios-shell.md](docs/ios-shell.md).

### Plan first

Before implementing a feature, read the relevant services, list the files that change, find the call sites and decide which test layer covers each behavior.

### Commits and branches

One commit per logical unit, source and tests together, with conventional prefixes (`feat:`, `fix:`, `feat(search):`, ...). Work on a branch and open a pull request; a push to `main` can deploy when Azure is configured, so only push to `main` when the change is meant to ship.

### Ask before destructive actions

Confirm before deleting files, force-pushing or rewriting history, changing cloud infrastructure, pushing to `main`, or exposing secrets.

## Tests

| Layer | Path | Detail |
|-------|------|------|
| Backend unit / integration | `backend/tests/**` | `.claude/rules/backend.md` |
| Frontend unit | `frontend/src/**/*.test.ts` | Vitest + jsdom |
| Frontend workflow e2e | `frontend/tests/e2e/**` | `.claude/rules/frontend.md` |
| Live deployment checks | `docs/testing/live-e2e-plan.md` | manual, against a real deployment |

Bug fixes get a regression test at the surface where the bug appeared.

## When you finish a task

- Run `make ci` (or at least `npx tsc --noEmit` and `npm test` in `backend/`) before committing.
- Update this file or the relevant `.claude/rules/*.md` if you changed an entity, table, MCP tool, route or service contract.
- If you delete or rename something, grep the docs for it and fix or remove the references.
