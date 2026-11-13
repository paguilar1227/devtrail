# DevTrail

Personal knowledge base + productivity tool. Single user. NotebookLM-style: organize knowledge into **projects**, dump documents/notes/todos into them, run hybrid semantic + entity-graph search across everything.

DevTrail runs as a single Hono process serving three surfaces — REST API, MCP server, and a Vite/React web UI — backed by PostgreSQL + pgvector and Azure Blob Storage. Multimedia ingestion (PDF/image/audio) and URL ingestion (YouTube/X/HTML) flow through the same chunking + embedding + entity-extraction pipeline.

## Quick start

```bash
# One command brings up Postgres + Azurite (Blob emulator) + backend + frontend
npm run dev:up

# UI:        http://localhost:5173
# Backend:   http://localhost:3001
# API docs:  http://localhost:3001/api/docs?key=local-dev-key-not-secret
# OpenAPI:   http://localhost:3001/api/openapi.json (Bearer or ?key=)

# Stop docker (data preserved): npm run dev:down
# Wipe volumes (with confirm):  npm run dev:reset
```

`dev:up` is idempotent: bootstraps `backend/.env` from `.env.example` if missing, runs `npm ci` anywhere `node_modules` is missing, brings up Docker, seeds an empty DB, and hands off to backend + frontend dev servers with HMR. Default config is **stub mode** (`LLM_PROVIDER=stub`) — every LLM + embedding call is faked deterministically, zero upstream API spend. Flip to real APIs by editing `backend/.env`.

## Features

### Content & retrieval

- **Project-scoped knowledge:** documents and notes can belong to multiple projects; todos belong to one (or live in a personal Inbox).
- **Multimodal ingestion:** PDFs, images (with OCR), audio (with transcription), all chunked and embedded via Gemini Embedding 2 (3072d, multimodal).
- **URL ingestion:** YouTube transcripts (Supadata), X/Twitter threads (xAI Grok), PDFs, HTML articles (Firecrawl) — `source_url` preserved and surfaced in citations.
- **Async ingest contract:** `POST /api/v1/content` and `/from-url` return 202 + `{id, processing_status: "pending"}`. Poll `/content/:id/status` until `ready` or `failed`.
- **Hybrid search:** vector seed + graph expansion along chunk→entity edges, fused via Reciprocal Rank Fusion. Each hit includes a `retrieval_path` explaining how it was reached.
- **Entity graph layer:** Haiku 4.5 extracts entities at ingest, resolved against a canonical registry (exact name, alias, embedding similarity). `find_mentions` returns every chunk that mentions a given entity.
- **RAG with auto-depth routing:** Haiku classifier picks fast (Azure GPT-5.4, ~3-5s) or thorough (Azure GPT-5.4 Pro Responses API, 15-60s) per question. Per-stage `timings_ms` in every response.

### Sessions and timelines

- **Session workspaces:** create or resume by a stable key, keep notes/documents/todos together, and optionally assign a project. Moving a session moves its owned work and history.
- **Session handoffs:** factual summaries, decisions, and next steps remain in session context and a searchable source note.
- **Durable timelines:** project history includes child sessions; session history is independently browsable. Search matches, cursor pagination, and shared AND/OR tag filters work across both. Deleted artifacts retain event metadata, never copied bodies. Existing data is marked as reconstructed history.
- **Navigation:** Sessions is available in the desktop sidebar and mobile More menu; each project has Sessions and Timeline tabs.
- **Cloud compatibility:** existing Easy Auth, Bearer API access, Azure Blob storage, 3072-dimensional embeddings, shared browse panels, folders, and root-only todo tags are retained.

### Tasks

- **Hierarchical todos** with subtasks, comments, status (`not_started` / `in_progress` / `paused` / `done`), priority (P1/P2/P3), due dates, tags.
- **Cascade behavior:** hard-deleting a parent todo cascades to all descendants (`parent_id ON DELETE CASCADE`); deleting a content item cascades to its chunks + chunk_entities.
- **Soft delete + restore + pin/unpin:** archive/unarchive on every entity, pin to the top of any list.
- **Bulk operations:** `POST /api/v1/{content,todos}/bulk` for archive/delete/tag-edit across many ids in one call.

### MCP server (32 tools)

Read tools: `list_projects`, `list`, `get`, `search`, `find_mentions`, `list_tags`, `list_comments`, `list_activity`, `ask`. Write tools: `create_project`, `create`, `update`, `replace`, `archive`, `restore`, `add_comment`, `update_comment`, `save_from_url`, `retry`, `reprocess`, `rename_tag`. Session tools: `list_sessions`, `create_session`, `update_session`, `get_session_context`, `get_project_context`, `save_session`, `session_timeline`, `project_timeline`, `delete_session`, `retry_session_cleanup`. Browse and search accept session scope and expose the shared filtering options.

Stateless: a fresh server + transport per request, mounted at `/mcp`. The server includes an `INSTRUCTIONS` string that Claude.ai / Claude Code apply automatically — covers project membership asymmetry (`project_id` vs `project_ids`), prefer-search-before-creating discipline, and the entity model.

## Architecture

| Layer | Technology |
|-------|-----------|
| API | Hono on Node 20, served by `@hono/node-server` |
| Web UI | Vite + React, no Tailwind; design system in `frontend/src/styles.css` |
| MCP | `@modelcontextprotocol/sdk` over Streamable HTTP, mounted at `/mcp` |
| Database | PostgreSQL + pgvector (3072-dim, sequential scan — no HNSW) |
| Blob storage | Azure Blob Storage (private; SAS-signed read URLs at API response time) |
| Container | Docker on Azure Container Apps |
| Web auth (prod) | Container Apps Easy Auth → Microsoft Entra ID; `/api/*` and `/mcp` excluded (Bearer-only) |
| Embeddings | Gemini Embedding 2 (`gemini-embedding-2-preview`, 3072d, multimodal) |
| Metadata + entity extraction | Anthropic Claude Haiku 4.5 |
| Query depth classifier | Anthropic Claude Haiku 4.5 |
| RAG fast path | Azure Foundry chat completions (gpt-5-4) |
| RAG thorough path | Azure Foundry Responses API (gpt-5-4-pro) |
| CI/CD | GitHub Actions (OIDC); CI runs unit + integration + Playwright e2e on every PR |

The Container App hosts all three surfaces in a single process. Adapters are thin; all business logic lives in `backend/src/services/` (see `CLAUDE.md` for the layout). Migrations auto-apply on startup.

## Repo layout

```
backend/                  # Hono API + MCP server (Node 20)
frontend/                 # Vite + React web client
shared/                   # @devtrail/shared — Zod schemas + TS types shared on the wire
migrations/               # SQL migrations applied on backend startup
scripts/                  # dev-up.sh, dev-down.sh, dev-reset.sh, deploy.sh, seed-local.ts
docs/                     # design docs, plans, UI build brief
.github/workflows/        # CI + Deploy to Azure
docker-compose.yml        # local Postgres (pgvector) + Azurite (Blob emulator)
Dockerfile                # multi-stage: frontend build → backend build → runtime
```

Root `package.json` is a thin orchestrator:

```bash
npm run dev:up        # full local stack from any state (recommended)
npm run dev:down      # stop docker, keep data
npm run dev:reset     # wipe volumes (with confirm)
npm run dev:full      # backend + frontend only (assumes compose up)
npm run seed:local    # populate DB with realistic projects/notes/todos
npm test              # backend test suite
npm run test:e2e      # frontend Playwright suite
npm run install:all   # backend + frontend deps
npm run build:all     # production build
```

## Schema

13 migrations under `migrations/`, applied idempotently on backend startup:

| File | What |
|------|------|
| `001_schema.sql` | projects, content_items, chunks, todos, todo_comments |
| `002_source_url.sql` | `source_url` on content_items for URL-ingested entries |
| `003_entities_graph.sql` | entities + chunk_entities tables, `published_at` on content_items |
| `004_processing_status.sql` | `processing_status` + `processing_error` on content_items (async ingest contract) |
| `005_backfill_control_chars.sql` | strip C0/DEL bytes from old content rows |
| `006_ingest_completed_at.sql` | `ingest_completed_at` for the polling endpoint |
| `007_pinned.sql` | `pinned_at` TIMESTAMPTZ + partial indexes on content_items, todos, projects |
| `008_manual_order.sql` | Per-sibling todo ordering |
| `009_content_folder.sql` | First-class content folders |
| `010_subtask_tags_cleanup.sql` | Root-only todo tags |
| `011_project_memory.sql` | Durable project sessions and handoff storage |
| `012_project_timeline.sql` | Transactional timeline capture and honest historical backfill |
| `013_session_workspaces.sql` | Session ownership, moves, cascading cleanup, and session timelines |


## API documentation

Full OpenAPI 3.1 spec at `/api/openapi.json`, Swagger UI at `/api/docs`. Both are Bearer-gated. For local: `http://localhost:3001/api/docs?key=local-dev-key-not-secret`. The page carries the `?key=` query param into all "Try it out" requests so you can exercise the API live.

37 paths across Projects, Content, Todos, Comments, Search, Tags, Activity, Diagnostics, MCP. Source of truth: `backend/src/openapi.ts`.

## Testing

235 tests across unit + integration. Unit tests cover providers, capture utilities, db client, MCP server wiring, services. Integration tests exercise the full REST surface against mocked deps + an in-memory pg.

```bash
npm test                                              # backend (unit + integration)
cd backend && npx tsc --noEmit                        # type check
cd backend && npx vitest run tests/integration/rest-api.test.ts  # single file
npm run test:e2e                                      # frontend Playwright
```

CI runs the full backend suite + frontend build + Playwright on every PR. No real upstream API keys required — all providers are mocked at the test boundary.

## Deployment

GitHub Actions deploys on every push to `main` (`.github/workflows/deploy.yml`). Build the container, push to ACR, update the Azure Container App, wait for `/health` 200, run a curl-based smoke job that hits health, REST gate, MCP initialize, and the auth-redirect.

The smoke job is intentionally **free** — only public + cheap endpoints. See the cost-invariant comment in `deploy.yml` before adding paid checks.

For first-time setup, see [`SETUP.md`](./SETUP.md). Manual deploy from a local machine:

```bash
RESOURCE_GROUP=<rg> ACR_NAME=<acr> ./scripts/deploy.sh
```

## Production

| | |
|--|--|
| App URL | `https://your-app.your-env.region.azurecontainerapps.io` |
| Health | `<app-url>/health` returns `{"ok":true,"service":"devtrail","version":"2.0.0"}` |
| Web UI | Easy Auth gated — sign in with Microsoft Entra ID (restricted to one user) |
| API | `<app-url>/api/v1/*` — Bearer auth (excluded from Easy Auth) |
| MCP | `<app-url>/mcp?key=<api-key>` — stateless, per-request server |
| API key | Azure Key Vault: `your-keyvault/devtrail-api-key` |
| Database | `your-pg-server.postgres.database.azure.com` |
| Storage | Azure Blob; `Allow Blob Public Access = false`; API generates short-lived SAS read URLs in responses |

## Documentation

- [`CLAUDE.md`](./CLAUDE.md) — instructions for AI sessions working on this codebase
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — deeper architectural notes
- [`SETUP.md`](./SETUP.md) — first-time Azure deployment walkthrough
- `/api/docs` — live Swagger UI for the REST surface
- `backend/src/openapi.ts` — OpenAPI 3.1 spec (source of truth for the contract)
