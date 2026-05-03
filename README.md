# Open Brain v2

Personal knowledge base + productivity tool. Single user. NotebookLM-style: organize knowledge into **projects**, dump documents/notes/todos into them, run hybrid semantic + entity-graph search across everything.

Open Brain runs as a single Hono process serving three surfaces — REST API, MCP server, and a Vite/React web UI — backed by PostgreSQL + pgvector and Azure Blob Storage. Multimedia ingestion (PDF/image/audio) and URL ingestion (YouTube/X/HTML) flow through the same chunking + embedding + entity-extraction pipeline.

## Features

### Content & retrieval

- **Project-scoped knowledge:** documents and notes can belong to multiple projects; todos belong to one (or live in a personal Inbox).
- **Multimodal ingestion:** PDFs, images (with OCR), audio (with transcription), all chunked and embedded via Gemini Embedding 2 (3072d, multimodal).
- **URL ingestion:** YouTube transcripts, X/Twitter threads, PDFs, HTML articles — `source_url` preserved and surfaced in citations.
- **Hybrid search:** vector seed + graph expansion along chunk→entity edges, fused via Reciprocal Rank Fusion. Each hit includes a `retrieval_path` explaining how it was reached.
- **Entity graph layer:** Haiku 4.5 extracts entities at ingest, resolved against a canonical registry (exact name, alias, embedding similarity). `find_mentions` returns every chunk that mentions a given entity.
- **RAG with auto-depth routing:** classifier picks fast (Azure GPT-5.4, ~3-5s) or thorough (Azure GPT-5.4 Pro Responses API, 15-60s) per question. Per-stage timing breakdown in every response.

### Tasks

- **Hierarchical todos** with subtasks, comments, status (`not_started` / `in_progress` / `paused` / `done`), priority (P1/P2/P3), due dates, tags.
- **Cascade behavior:** hard-deleting a parent todo cascades to all descendants (`parent_id ON DELETE CASCADE`); deleting a content item cascades to its chunks + chunk_entities.
- **Soft delete + restore:** archive/unarchive on every entity.

### MCP server (8 tools)

`list_projects`, `create_project`, `list`, `get`, `create`, `search` (hybrid), `find_mentions` (graph), `save_from_url`. The server includes behavioral instructions that are auto-applied by Claude.ai / Claude Code on connection — no user setup needed.

## Architecture

| Layer | Technology |
|-------|-----------|
| API | Hono on Node 20, served by `@hono/node-server` |
| Web UI | Vite + React + Tailwind, built into `frontend/dist`, served statically by Hono |
| MCP | `@modelcontextprotocol/sdk` over Streamable HTTP, mounted at `/mcp` |
| Database | PostgreSQL + pgvector (3072-dim, sequential scan — no HNSW) |
| Blob storage | Azure Blob Storage (private; SAS-signed read URLs at API response time) |
| Container | Docker on Azure Container Apps |
| Embeddings | Gemini Embedding 2 (`gemini-embedding-2-preview`, 3072d, multimodal) |
| Metadata + entity extraction | Anthropic Claude Haiku 4.5 |
| Query depth classifier | Anthropic Claude Haiku 4.5 |
| RAG fast path | Azure Foundry chat completions (gpt-5-4) |
| RAG thorough path | Azure Foundry Responses API (gpt-5-4-pro) |
| CI/CD | GitHub Actions (OIDC) |

The Container App hosts all three surfaces in a single process. Adapters are thin; all business logic lives in `backend/src/services/` (see `CLAUDE.md` for the layout). Migrations auto-apply on startup.

## Repo layout

```
backend/                  # Hono API + MCP server (Node 20)
frontend/                 # Vite + React + Tailwind web client
migrations/               # SQL migrations applied on backend startup
scripts/                  # deploy.sh, live-e2e.sh, diagnostics
docs/                     # design docs, plans, UI build brief
.github/workflows/        # CI + Deploy to Azure
Dockerfile                # multi-stage: frontend build → backend build → runtime
```

Root `package.json` is a thin script delegator:

```bash
npm run install:all        # backend + frontend deps
npm run dev                # backend dev server
npm test                   # backend test suite
npm run build:all          # production build of both
```

## Schema

3 migrations under `migrations/`:

- `001_schema.sql` — projects, content_items, chunks, todos, todo_comments
- `002_source_url.sql` — adds `source_url` to content_items for URL-ingested entries
- `003_entities_graph.sql` — entities + chunk_entities tables, `published_at` on content_items (content time vs ingest time)

## Local development

```bash
# 1. Local Postgres (pgvector image, mapped to host port 5434 to avoid clashing with the system 5432)
docker compose up -d

# 2. Backend + frontend deps
npm run install:all

# 3. Configure environment
cp .env.example .env
# edit .env — DATABASE_URL=postgresql://openbrain:openbrain@localhost:5434/openbrain
# plus GEMINI_API_KEY, ANTHROPIC_API_KEY, AZURE_STORAGE_CONNECTION_STRING,
#       AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY, XAI_API_KEY, FIRECRAWL_API_KEY,
#       OPEN_BRAIN_API_KEY (any string for local)

# 4. Backend dev server (auto-runs migrations on first boot)
npm run dev

# 5. Frontend dev server (separately)
cd frontend && npm run dev
```

## Testing

88 tests across 12 files: provider-level mocks, MCP server wiring, REST integration against a test pg, URL detection, multimodal upload paths, chunker, blob client.

```bash
# All tests (delegates to backend)
npm test

# Type check (from backend/)
cd backend && npx tsc --noEmit

# Single file (from backend/)
cd backend && npx vitest run tests/integration/rest-api.test.ts
```

There is no separate e2e suite in the repo. The integration tests already exercise the full app surface against mocked providers. For full live-system validation see [`E2E_TEST_PLAN.md`](./E2E_TEST_PLAN.md) — a manual test plan that hits production.

## Deployment

GitHub Actions deploys on every push to `main` (`.github/workflows/deploy.yml`). Build the container, push to ACR, update the Azure Container App.

For first-time setup, see [`SETUP.md`](./SETUP.md). Manual deploy from a local machine:

```bash
RESOURCE_GROUP=<rg> ACR_NAME=<acr> ./scripts/deploy.sh
```

## Production

| | |
|--|--|
| App URL | `https://your-app.your-env.region.azurecontainerapps.io` |
| Health | `<app-url>/health` returns `{"ok":true,"service":"open-brain","version":"2.0.0"}` |
| MCP | `<app-url>/mcp?key=<api-key>` (stateless, per-request server) |
| API key | Azure Key Vault: `your-keyvault/open-brain-api-key` |
| Database | `your-pg-server.postgres.database.azure.com` |
| Storage | Azure Blob; `Allow Blob Public Access = false`; API generates short-lived SAS read URLs in responses |

## Documentation

- [`CLAUDE.md`](./CLAUDE.md) — instructions for AI sessions working on this codebase
- [`E2E_TEST_PLAN.md`](./E2E_TEST_PLAN.md) — reproducible 52-test live-system validation
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — deeper architectural notes (currently being updated for V2)
- [`SETUP.md`](./SETUP.md) — first-time Azure deployment walkthrough (currently being updated for V2)
