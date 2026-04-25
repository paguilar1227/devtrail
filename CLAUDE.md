# CLAUDE.md — Open Brain v2

Project-specific instructions for AI sessions working on this codebase.

## Reality check first

Before trusting anything in this file, this CLAUDE.md, prior session notes, or your auto-memory: **verify against the current code**. Architecture changes happen between sessions. Cheap checks before committing to a mental model:

- `git log --oneline -20` — what changed recently
- `find src -type f -name '*.ts' | sort` — what files actually exist
- `ls migrations/` — what schema is current
- `cat package.json` — what dependencies are current
- A live `/health` hit on production confirms what's deployed

If a memory or doc references a file path, function, or entity name that no longer exists in the repo, treat the doc as stale and update it. **Don't chase a phantom architecture.** Past pivots have completely replaced the entity model and code layout — assumptions from older sessions go stale fast.

## What Open Brain v2 is (current state — verified 2026-04-24)

A NotebookLM-style personal knowledge base + productivity tool. Single user. No multi-tenancy.

- **Projects** group everything else.
- **Content items** are documents (uploaded reference material) and notes (self-authored). Both get chunked for search.
- **Chunks** are the unit of vector search.
- **Todos** with optional project membership, recursive subtasks, comments.
- **Entities + chunk_entities** form a graph layer over the corpus — extracted at ingest, used to expand vector retrieval along entity edges.

There is **no Telegram bot**, **no consolidation/facts/insights pipeline**, **no reflection engine**. Those existed in pre-pivot versions and were deleted in the V2 rewrite (April 2026). If you find references to them anywhere outside legacy infra (`functions/consolidation-trigger`), fix the docs.

## Stack

| Layer | Tech |
|------|------|
| API | Hono on Node 20, served by `@hono/node-server` |
| Web UI | Vite + React + Tailwind, built into `web/dist`, served statically by Hono |
| MCP | `@modelcontextprotocol/sdk` over Streamable HTTP, mounted at `/mcp` |
| Database | PostgreSQL + pgvector (3072-dim, sequential scan — no HNSW) |
| Blob storage | Azure Blob Storage |
| Container | Docker on Azure Container Apps |

## Models (see `src/server.ts`)

| Role | Provider | Model |
|------|----------|-------|
| Embeddings | Gemini | `gemini-embedding-2-preview` (3072d, multimodal) |
| Metadata + entity extraction | Anthropic | `claude-haiku-4-5-20251001` |
| Query depth classifier | Anthropic | `claude-haiku-4-5-20251001` |
| RAG fast path | Azure Foundry chat completions | `gpt-5-4` |
| RAG thorough path | Azure Foundry Responses API | `gpt-5-4-pro` |

## Schema (3 migrations, see `migrations/`)

- `001_schema.sql` — projects, content_items, chunks, todos, todo_comments
- `002_source_url.sql` — adds `source_url` column to content_items for URL-ingested content
- `003_entities_graph.sql` — entities, chunk_entities, `published_at` column on content_items

Auto-migration runs on container startup (`runMigrations()` in `src/server.ts`). It checks for table existence and applies missing migrations idempotently.

**No HNSW indexes.** B1ms tier doesn't have memory for HNSW init at 3072 dims. Sequential scan is fine at single-user scale.

## Code layout

```
src/
├── app.ts                  # Hono app factory: REST routes + MCP mount + static web
├── server.ts               # Entry point: deps wiring + migrations + serve
├── config.ts               # Zod-validated env config
├── capture/
│   ├── chunker.ts          # 500/100 sliding window with sentence-boundary alignment
│   ├── ingest-trace.ts     # Per-ingest trace IDs + fingerprints
│   ├── metadata.ts         # Haiku metadata: title, topics, tags, extracted_text, published_at
│   └── url-detect.ts       # Classify URL type (YouTube, X, PDF, image, audio, html)
├── db/                     # Raw SQL, no ORM. One module per table.
│   ├── client.ts           # pg.Pool wrapper that registers pgvector types on first use
│   ├── projects.ts
│   ├── content-items.ts
│   ├── chunks.ts
│   ├── todos.ts
│   ├── todo-comments.ts
│   └── entities.ts         # entities + chunk_entities edges
├── services/               # Business logic. Adapters (REST, MCP) call into here.
│   ├── index.ts            # ServiceDeps interface (DI contract)
│   ├── projects.ts
│   ├── content-items.ts    # createContentItem orchestrates dedup→upload→metadata→chunk→embed→graph
│   ├── todos.ts
│   ├── todo-comments.ts
│   ├── search.ts           # Hybrid vector + graph search with RRF fusion + retrieval_path
│   ├── rag.ts              # Q&A: depth classify → search → synthesize via fast or pro
│   ├── query-depth.ts      # Haiku classifier: fast vs thorough + entity extraction
│   ├── entities.ts         # extract → resolve → map mentions to chunks → persist edges
│   └── url-ingest.ts       # YouTube / X / PDF / HTML ingestion → content-items pipeline
├── providers/
│   ├── types.ts            # EmbeddingProvider, LLMProvider interfaces
│   ├── gemini-embedding.ts
│   ├── gemini-llm.ts
│   ├── anthropic-llm.ts
│   ├── azure-foundry-llm.ts        # Chat completions (gpt-5-4)
│   ├── azure-foundry-responses.ts  # Responses API (gpt-5-4-pro)
│   ├── pdf-extract.ts      # pdf-parse v2 PDFParse class
│   ├── youtube-transcript.ts
│   ├── firecrawl.ts        # HTML extraction fallback
│   ├── xai.ts              # X/Twitter live-search via Grok
│   └── json-utils.ts       # extractJson() — strips markdown fences from LLM output
├── mcp/
│   └── server.ts           # 8 MCP tools (see "MCP tools" below)
└── storage/
    └── blob.ts             # Azure Blob upload/download
```

### Service layer pattern

Adapters (REST in `app.ts`, MCP in `mcp/server.ts`) are thin: parse input → call a service function → format response. **All business logic lives in `src/services/`.** Service functions take `ServiceDeps` (the DI container with db, providers, blob, config) as their first argument. Direction of dependency: adapters → services → db/providers. Never import adapter code from services.

## MCP tools (8 total — defined in `src/mcp/server.ts`)

1. `list_projects` — list all (filter by status optional)
2. `create_project`
3. `list` — entity_type-filtered browse (document / note / todo)
4. `get` — fetch by UUID, auto-detects type (project / content / todo)
5. `create` — discriminated union over document / note / quick_note / todo
6. `search` — hybrid vector + graph semantic search, RRF-fused, with `retrieval_path` per hit
7. `find_mentions` — exact entity lookup (canonical name or alias) → list of chunks
8. `save_from_url` — ingest by URL (YouTube / X / PDF / HTML / direct media)

The MCP server passes a long `INSTRUCTIONS` string to clients that support it (Claude.ai, Claude Desktop, Claude Code). It tells the AI to scope project queries, prefer `search` before answering from training, dedup before creating, and never invent UUIDs. **No `update_*` or `delete_*` tools** — the web UI handles edits.

### Project membership (asymmetric — easy to get wrong)

| Entity | Membership field |
|--------|------------------|
| document, note, quick_note | `project_ids[]` (array, multi-project) |
| todo | `project_id` (single string, nullable = personal Inbox) |

Mixing them up will make the call fail.

## REST API

Auth: `Authorization: Bearer <api-key>` or `?key=<api-key>`. Same key for `/api/*` and `/mcp`.

Routes (see `src/app.ts`):

- `GET /health`
- `GET|POST|PUT|DELETE /api/v1/projects[/:id]` + `POST /api/v1/projects/:id/restore`
- `GET|POST|PUT|DELETE /api/v1/content[/:id]` + `POST /api/v1/content/from-url` + `POST /api/v1/content/:id/restore`
  - `POST /api/v1/content` accepts JSON or `multipart/form-data` (with `file` field for uploads)
- `GET|POST|PUT|DELETE /api/v1/todos[/:id]` + restore
- `GET|POST|PUT|DELETE /api/v1/todos/:id/comments[/:cid]`
- `POST /api/v1/search` — hybrid vector + graph
- `POST /api/v1/find-mentions`
- `POST /api/v1/rag` — RAG Q&A with `depth: 'auto' | 'fast' | 'thorough'`
- `ALL /mcp` — stateless MCP, fresh server + transport per request

Soft delete by default (`archived = true`); pass `?hard=true` for permanent delete.

## Development workflow

### Local cycle

```bash
npx tsc --noEmit           # types
npm test                    # full vitest run (12 files, 88 tests as of 2026-04-24)
docker compose up -d        # local Postgres on port 5434 (avoid clashing with 5432)
npm run dev                 # tsx watch on src/server.ts
```

There is **no separate e2e suite**. The integration tests in `tests/integration/` already exercise the full app surface (REST + MCP) against mocked providers and an in-memory or test pg.

### Plan-first

Before implementing a feature: read the relevant services, list the files that change, identify call sites, write tests at the right layer. Don't start coding until the picture is clear.

### Commit style

One commit per logical unit. Group source + tests in the same commit. Conventional-style prefixes: `feat:`, `fix:`, `feat(graph):`, `fix(search):`, etc. (See `git log` for style.)

### After pushing

CI and Deploy run independently on every push to `main`. Both must pass. Poll until both are done:

```bash
while true; do
  RESULT=$(gh run list --repo paguilar1227/open-brain-v2 --limit 2 --json status,conclusion,name --jq '.[] | "\(.status) \(.conclusion) \(.name)"')
  CI=$(echo "$RESULT" | grep "^completed.*CI$" | head -1)
  DEPLOY=$(echo "$RESULT" | grep "^completed.*Deploy" | head -1)
  if [ -n "$CI" ] && [ -n "$DEPLOY" ]; then
    echo "$CI"; echo "$DEPLOY"; break
  fi
  sleep 5
done
```

CI passing while Deploy fails (and vice versa) is possible. Report both.

### Ask before destructive actions

Confirm before:
- Deleting files (could they still be needed?)
- Force-pushing, resetting, or rewriting git history
- Modifying Azure infra
- Exposing secrets or the user's IP

## Test layout

| Layer | Path | What |
|-------|------|------|
| Unit | `tests/unit/**` | Single modules: providers, db client, mcp server wiring, capture utilities, storage |
| Integration | `tests/integration/rest-api.test.ts` | All REST endpoints against mocked deps |
| Integration | `tests/integration/mcp-integration.test.ts` | MCP tool surface end-to-end |
| Integration | `tests/integration/url-ingest.test.ts` | URL classification + fetcher routing (mocked YouTube/Firecrawl/xAI) |
| Integration | `tests/integration/archive-delete.test.ts` | Soft- and hard-delete flows |

Mocks live in `tests/helpers/mocks.ts`. Add new tests at the appropriate layer when you change behavior. Bug fixes get a regression test.

Run a single file:
```bash
npx vitest run tests/integration/rest-api.test.ts
```

## Known gotchas

### LLMs

- **Markdown-wrapped JSON.** Anthropic and Gemini both sometimes return JSON inside ` ```json … ``` ` fences even with `responseFormat: 'json'`. Always pipe `LLMProvider` JSON output through `extractJson()` from `src/providers/json-utils.ts` before `JSON.parse`.
- **Output token budget.** Haiku 4.5 metadata calls use `maxTokens: 8192` for PDF-scale inputs (raised from 2048 — see `fix(metadata): raise Flash maxTokens 2048→8192 for PDF-scale inputs`). For entity extraction, 4096 is enough because we cap input at 50k chars.
- **Model IDs change.** Verify the current ID if you get 404s. The codebase pins Haiku to `claude-haiku-4-5-20251001` explicitly.

### Gemini Embedding 2

- Model ID: `gemini-embedding-2-preview`. Default dim is 768 — we explicitly request 3072.
- Multimodal: accepts `image/png`, `image/jpeg`, `audio/mpeg`, `audio/wav`, `video/mp4`, `video/quicktime`, `application/pdf`.
- The Generative Language API must be enabled on the GCP project tied to the API key.

### PostgreSQL / pgvector

- `db.query()` calls `ensureVector()` which lazily registers pgvector types on first use. Migrations that create the `vector` extension must use `pool.query()` directly (not `db.query()`) to avoid the chicken-and-egg.
- HNSW is **not** in use — too memory-hungry for B1ms at 3072 dims. Sequential scan is the current cost.
- Migrations are checked by table-existence probes in `runMigrations()`. Adding a new migration: add the file and a new probe in `src/server.ts`.

### Search and RAG

- `search()` returns hits with a `retrieval_path` array showing which path (vector / entity expansion / both) reached the chunk. RRF fusion combines the lists. `graph: false` opts out of expansion.
- `ragQuery()` first runs the depth classifier (Haiku) which both classifies fast/thorough AND extracts named entities to seed graph expansion. `depth: 'fast'|'thorough'` skips the classifier (zeroes its timing).
- Per-stage timing is on every RAG response (`meta.timings_ms`). Use it to diagnose latency.

### URL ingestion

- YouTube: tries direct scrape → Firecrawl → xAI as fallbacks. Only succeeds when one returns a transcript.
- X/Twitter: xAI Grok live-search primary, Firecrawl stealth fallback.
- PDFs: downloaded as bytes → text via `pdf-parse` v2 PDFParse class. Watch for the v2 API change — older docs reference a function import that no longer exists.
- HTML: Firecrawl markdown extraction. Reject results shorter than 300 chars or matching error/placeholder titles.
- Dedup: by `source_url` first, then by `file_hash` for binary downloads.

### Legacy infrastructure (cleanup candidates)

- `functions/consolidation-trigger/` and the deploy step that publishes it (`Azure Function` step in `.github/workflows/deploy.yml`) are leftovers from the pre-pivot architecture. The function probably no-ops, but it's still being deployed. Consider removing on a quiet day.
- `scripts/deploy.sh` also still publishes the function. If you delete the function, update this too.

## Production environment

- **App URL:** `https://your-app.your-env.region.azurecontainerapps.io`
- **MCP URL:** `<app-url>/mcp?key=<api-key>` (stateless, per-request server)
- **Health:** `<app-url>/health` returns `{"ok":true,"service":"open-brain","version":"2.0.0"}`
- **API key:** Azure Key Vault `your-keyvault/open-brain-api-key`
- **PostgreSQL:** `your-pg-server.postgres.database.azure.com` (Azure Postgres Flexible Server)
- **Azure Container App:** resource group `openbrain-rg`, name `openbrain-prod-api`
- **Local dev Postgres:** port 5434 (so it doesn't clash with other projects on 5432)

## Failure modes that have happened

These are real, not hypothetical. Tests cover most.

1. **Markdown-fenced JSON breaking parses** — fixed by routing all JSON through `extractJson()` in `json-utils.ts`. Whenever you add a new LLM-JSON path, route it through there.
2. **PDF parsing API change** — `pdf-parse` v2 ships a `PDFParse` class instead of the v1 default-import function. Use the class.
3. **Firecrawl HTML returning placeholder pages** — error/404/"Example Domain" titles must be rejected; bare-minimum content length must be > 300 chars to count as real ingestion.
4. **xAI X-search returning miss responses** — detect failure phrases up front and surface a clean `X_SEARCH_MISS:` error rather than saving useless content.
5. **YouTube snowflake IDs vs date windows** — decode the post snowflake to derive a ±6hr search window so x_search can actually find the post.
6. **HNSW init OOM** — don't try to add the index on B1ms. If you need faster search, either upsize the DB or use a smaller embedding dim.
7. **Past phantom-architecture sessions** — if the doc and the code disagree, the code wins. Update the doc immediately.

## When you finish a task

- Run `npx tsc --noEmit` and `npm test` before committing.
- Update CLAUDE.md if you changed an entity, table, MCP tool, or service-layer contract. Stale docs cost more than they save.
- If you delete or rename a service / table / file, grep the docs for it (`grep -rn 'old-name' --include='*.md'`) and fix or remove references.
