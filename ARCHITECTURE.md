# Open Brain v2 — Architecture

Authoritative reference for the V2 codebase. Written for AI agents and humans who want a complete, factual picture of what is *actually built* — not what was designed in the V1 era.

> **Reality check first.** Architecture changes happen between sessions. Cheap checks before trusting this doc:
> - `git log --oneline -20` — recent changes
> - `find src -type f -name '*.ts' | sort` — what files actually exist
> - `ls migrations/` — current schema
> - `cat package.json` — current deps
> - `curl <app-url>/health` — what's deployed
>
> If a memory or doc references a file/function/entity that no longer exists in the repo, **the code wins**. Update or remove the stale doc.

---

## 1. Purpose

Open Brain v2 is a **single-user, NotebookLM-style personal knowledge base + productivity tool**. The user organizes knowledge into **projects**; each project contains documents (uploaded reference material), notes (self-authored), and todos (with subtasks + comments). Hybrid semantic + entity-graph search spans everything. A retrieval-augmented Q&A surface routes between a fast model and a reasoning model based on the question.

There is **no multi-tenancy**. There is **no Telegram bot**, **no consolidation/facts/insights pipeline**, **no reflection engine** — those existed in the pre-V2 architecture and were deleted in the April 2026 rewrite. Vestigial Bicep parameters and the `functions/consolidation-trigger/` folder still exist as cleanup candidates (see §16).

Three client surfaces:

| Surface | Path | Used by |
|---------|------|---------|
| REST API | `/api/v1/*` | Web UI, scripts, automated tests |
| MCP server | `/mcp` | Claude.ai, Claude Desktop, Claude Code, ChatGPT, any MCP-aware client |
| Web UI | `/` (static) | The user's browser |

All three surfaces run in a single Hono process on Node 20, deployed as a Docker container to Azure Container Apps.

---

## 2. System Overview

```
                        Internet
                            |
                +-----------+-----------+
                |           |           |
            Web UI      MCP Clients  REST API
            (browser)   (Claude*)    (curl, web UI fetch)
                |           |           |
                +-----------+-----------+
                            |
            Azure Container App (minReplicas: 1, always-on)
            +---------------------------------------------+
            |  Hono process on :3000                       |
            |                                              |
            |  /                Static web UI from web/dist|
            |  /health          {"ok":true,...}            |
            |  /api/v1/*        REST adapter (src/app.ts)  |
            |  /mcp             MCP adapter (per-request)  |
            |                                              |
            |  Auto-migrations on startup (001/002/003)    |
            +---------------------------------------------+
                |              |              |
                |              |              |
       +--------+        +-----+-----+     +-+----+-----+
       |                 |           |     |             |
   PostgreSQL        Azure Blob   Gemini   Anthropic   Azure Foundry
   + pgvector        Storage      API      API         (OpenAI)
   (B1ms,            (private,
    no HNSW)         SAS URLs)    Embedding   Haiku 4.5   gpt-5-4
                                  2 + Flash   (Claude)    gpt-5-4-pro
                                              + xAI + Firecrawl
                                              for URL ingest fallbacks
```

### Architecture pattern: thin adapters, fat services

All business logic lives in `src/services/`. The two API adapters — REST in `src/app.ts`, MCP in `src/mcp/server.ts` — are thin: parse input, call a service function, format response. Service functions accept `ServiceDeps` (the dependency injection container with db, providers, blob, config) as their first argument.

Direction of dependencies: **adapters → services → db/providers**. Adapters never call other adapters. Services never import adapter code. This makes service-layer functions trivial to unit-test (pass mocks via `ServiceDeps`) and lets new adapter surfaces drop in without touching business logic.

---

## 3. Stack

| Layer | Tech |
|-------|------|
| API | Hono on Node 20, served by `@hono/node-server` |
| Web UI | Vite + React + Tailwind, built into `web/dist`, served statically by Hono |
| MCP | `@modelcontextprotocol/sdk` over `WebStandardStreamableHTTPServerTransport` (stateless, fresh server + transport per request) |
| Database | PostgreSQL Flexible Server (B1ms) + pgvector (3072-dim, sequential scan — no HNSW) |
| Blob storage | Azure Blob Storage (`Allow Blob Public Access = false`; SAS read URLs at API response time) |
| Container | Docker on Azure Container Apps |
| CI/CD | GitHub Actions (OIDC) |
| Migrations | Auto-applied on container startup via `runMigrations()` in `src/server.ts` |

### AI models

| Role | Provider | Model ID | Dependency-injection key |
|------|----------|----------|--------------------------|
| Embeddings | Gemini | `gemini-embedding-2-preview` (3072d, multimodal) | `embeddingProvider` |
| Metadata + entity extraction (text, image OCR, pdf-extracted text) | Anthropic | `claude-haiku-4-5-20251001` | `metadataLLM` |
| Metadata for audio/video (Haiku doesn't accept audio input) | Gemini | `gemini-3-flash-preview` | `mediaMetadataLLM` |
| Query depth classifier + query-entity extractor | Anthropic | `claude-haiku-4-5-20251001` | `queryDepthLLM` |
| RAG fast path | Azure Foundry chat completions | `gpt-5-4` (default; `AZURE_RAG_DEPLOYMENT`) | `ragFastLLM` |
| RAG thorough path | Azure Foundry Responses API | `gpt-5-4-pro` (default; `AZURE_DEEP_RAG_DEPLOYMENT`) | `ragDeepLLM` |

Wired in `src/server.ts`. The `ServiceDeps` interface is in `src/services/index.ts`.

---

## 4. Data Architecture

5 core tables + 2 graph-layer tables. No ORM — raw SQL via the `pg` driver, with one `db/*.ts` module per table.

```
projects
  +------------------------+
  | id, name, description, |
  | status, archived,      |
  | created/updated_at     |
  +------------------------+
        ^                ^
        | uuid[]         | uuid (FK, ON DELETE SET NULL)
        |                |
content_items          todos
  +-----------+        +------------------+
  | id        |        | id               |
  | type:     |        | content          |
  |  document |        | status           |
  |  /note    |        | priority         |
  | content   |        | due_date         |
  | source_url|        | parent_id (rec)  |
  | published_at        | tags[]           |
  | tags[]    |        | embedding(3072)  |  ← also chunked+embedded
  | project_ids[]      | archived         |
  | mime_type |        +------------------+
  | blob_url  |              ^
  | file_hash |              | uuid (FK, ON DELETE CASCADE)
  +-----------+              |
       |                todo_comments
       | uuid (FK,      +------------------+
       |  ON DELETE     | id, todo_id,     |
       |  CASCADE)      | content,         |
       v               | created/updated  |
   chunks               +------------------+
  +-----------+
  | id        |
  | content_  |
  |  item_id  |
  | content   |
  | embedding |
  | chunk_idx |
  +-----------+
       ^
       | uuid (FK,
       |  ON DELETE CASCADE)
       |
       v
  chunk_entities (graph layer)        entities (graph layer)
  +--------------------+               +-------------------------+
  | chunk_id (FK)      |   many:many   | id                      |
  | entity_id (FK)     |<------------->| canonical_name          |
  | confidence         |               | type: person/org/concept|
  | created_at         |               |       /tool/paper       |
  +--------------------+               | aliases[]               |
                                       | embedding(3072)         |
                                       +-------------------------+
```

### Project membership (asymmetric — easy to mistake)

| Entity | Field | Cardinality |
|--------|-------|-------------|
| `content_items` (documents, notes) | `project_ids` (uuid[]) | Multi-project; empty array = personal/Inbox |
| `todos` | `project_id` (uuid, nullable) | Single project; `null` = personal Inbox |

Mixing them up is a top-3 bug source — REST and MCP both fail loudly when the wrong field is sent. The MCP server's `INSTRUCTIONS` block calls this out explicitly.

### Why some FKs cascade and others don't

| Relationship | Constraint | Reason |
|--------------|-----------|--------|
| `chunks.content_item_id` → `content_items.id` | `ON DELETE CASCADE` | A chunk only exists as part of its parent item |
| `chunk_entities.chunk_id` → `chunks.id` | `ON DELETE CASCADE` | A graph edge only exists for an existing chunk |
| `chunk_entities.entity_id` → `entities.id` | `ON DELETE CASCADE` | Same — edges to a deleted entity have no meaning |
| `todos.parent_id` → `todos.id` | `ON DELETE CASCADE` | Subtasks die with their parent (recursive) |
| `todo_comments.todo_id` → `todos.id` | `ON DELETE CASCADE` | Comments die with their todo |
| `todos.project_id` → `projects.id` | `ON DELETE SET NULL` | Orphaned todos become Inbox items |
| `content_items.project_ids` → `projects.id` | `uuid[]` (no FK) | Multi-project membership; can't be a single FK |

Because `project_ids` is `uuid[]`, deleting a project does **not** cascade-delete its content. To prevent dangling references, `deleteProjectHard()` runs `array_remove(project_ids, $1::uuid)` across all content_items in the same transaction. So a doc that only belonged to a deleted project ends up with `project_ids: []` (back in personal scope), not a stale UUID. Verified end-to-end in `E2E_TEST_PLAN.md` T9.4.

### Embeddings

- `chunks.embedding`, `todos.embedding`, `entities.embedding` are all `vector(3072)`.
- Sequential scan only — no HNSW. B1ms can't allocate enough `maintenance_work_mem` for HNSW init at 3072 dims, and at single-user scale (low thousands of chunks) sequential cosine is well under 100ms/query. To unblock larger corpora: upsize the DB tier, or use Matryoshka truncation on Gemini Embedding 2 to a smaller dim where HNSW fits.

### Migrations

Three SQL files under `migrations/`:

| File | Adds |
|------|------|
| `001_schema.sql` | `projects`, `content_items`, `chunks`, `todos`, `todo_comments` + pgvector extension + B-tree/GIN indexes |
| `002_source_url.sql` | `source_url` column on `content_items` for URL-ingested entries |
| `003_entities_graph.sql` | `entities`, `chunk_entities`, `published_at` column on `content_items` |

Auto-applied by `runMigrations()` in `src/server.ts` on every container start, idempotently (each migration is gated on a table-existence or column-existence probe). Adding a new migration means: drop the file, add a probe in `runMigrations()`. Migrations that create the `vector` extension must use `pool.query()` directly (not the pgvector-typed client) to avoid the chicken-and-egg of registering pgvector types before the extension exists.

---

## 5. Service Layer

`src/services/index.ts` defines the `ServiceDeps` interface — the DI contract that every service function takes as its first argument:

```typescript
interface ServiceDeps {
  db: DbClient;
  embeddingProvider: EmbeddingProvider;
  metadataLLM: LLMProvider;       // Haiku 4.5 — text, image OCR, pdf-extracted text
  mediaMetadataLLM: LLMProvider;  // Gemini 3 Flash Preview — audio/video
  ragFastLLM: LLMProvider;        // Azure gpt-5-4
  ragDeepLLM: LLMProvider;        // Azure gpt-5-4-pro
  queryDepthLLM: LLMProvider;     // Haiku 4.5 — fast/thorough classifier + entity extractor
  blobStorage: BlobStorage;
  config: Config;
}
```

### Service modules (`src/services/`)

| Module | Responsibility |
|--------|---------------|
| `index.ts` | `ServiceDeps` interface |
| `projects.ts` | Project CRUD + soft/hard delete + project-UUID scrub on hard delete |
| `content-items.ts` | `createContentItem` orchestrates: dedup → optional blob upload → metadata extraction → chunking → embedding → entity-graph wiring |
| `todos.ts` | Todo + subtask CRUD with depth/parent management, embedding on insert/update |
| `todo-comments.ts` | Comment CRUD |
| `search.ts` | `searchWithTimings()` — hybrid vector + graph search with RRF fusion + per-hit `retrieval_path` |
| `rag.ts` | `ragQuery()` — depth classify → search → synthesize via fast or thorough LLM, returns answer + citations + per-stage timing |
| `query-depth.ts` | Haiku-based fast/thorough classifier; **also** extracts named entities from the query (used by both RAG and search to seed graph expansion) |
| `entities.ts` | `extractEntities` (Haiku) → resolve against canonical registry (exact name, alias, embedding similarity > 0.85) → map mentions to chunks → persist `chunk_entities` edges |
| `url-ingest.ts` | Classify URL → fetch via the right pipeline (YouTube, X/Twitter, PDF, HTML, direct media) → hand off to `content-items.ts` |

---

## 6. Ingest Pipeline

All ingest paths converge on `createContentItem()` in `src/services/content-items.ts`. Inputs are normalized into `{ type, title, content, project_ids, tags, source_url?, files? }` upstream of the service.

### Phases

```
1. Dedup
   - source_url match (URL ingest) → return existing id, deduped: true
   - file_hash match (uploaded binary) → reuse existing item, optionally relink to additional projects

2. (For uploads) Upload files to Blob Storage
   - mime resolved via inferMimeFromFilename when client sent application/octet-stream
   - file_hash computed (SHA-256) before upload

3. Metadata extraction (Haiku, OR Gemini for audio/video)
   - Routing: filesForMeta.some(f => mime startsWith 'audio/'|'video/') → mediaMetadataLLM
   - Returns: title, topics, tags, extracted_text (for binary inputs), published_at

4. Chunking (src/capture/chunker.ts)
   - 500-token target, 100-token overlap, sentence-boundary aligned
   - Single-chunk for short content (<~600 chars); multi-chunk for PDFs / long notes

5. Per-chunk embedding (Gemini Embedding 2)
   - 3072-dim, currently sequential per chunk

6. Entity extraction (src/services/entities.ts)
   - Run Haiku on full extracted text (capped at 50K chars)
   - Returns up to N named entities with type, mentions[], confidence
   - For each entity:
     - Resolve against `entities` table (exact canonical or alias match → embedding similarity ≥ 0.85)
     - If unresolved, INSERT new entity row with embedded canonical name
     - Map mentions to chunks (verbatim string search across chunk content)
   - Surface-fallback sweep: for any chunk that contains the canonical name or any alias verbatim but doesn't already have an edge, add the edge (covers chunks Haiku didn't quote in its mention list)
   - INSERT (chunk_id, entity_id, confidence) into chunk_entities (idempotent — skip duplicates)

7. INSERT chunks (transaction)
```

### Why audio/video routes through Gemini

Anthropic SDK doesn't accept audio input — it silently maps non-text content to `image/png` and produces garbage. We catch this at the service layer: when any file in `filesForMeta` has `audio/*` or `video/*` mime, the call routes to `mediaMetadataLLM` (Gemini 3 Flash Preview) instead. Everything else stays on Haiku for consistency + entity-extraction quality (~3% hallucination vs Gemini's higher rate on extraction tasks). Logged as commit `3178b24`.

### URL ingest (`src/services/url-ingest.ts`)

`classifyUrl()` (`src/capture/url-detect.ts`) inspects the URL and routes:

| Pattern | Type | Fetcher |
|---------|------|---------|
| `youtube.com/watch?v=` / `youtu.be/...` | youtube | `youtube-transcript` → Firecrawl → xAI Grok (live search) |
| `x.com/...` / `twitter.com/...` | x | xAI Grok live-search → Firecrawl stealth fallback |
| `*.pdf` (or content-type) | pdf | Direct download → `pdf-parse` v2 (PDFParse class) |
| `image/*`, `audio/*` | media | Direct download → blob → metadata via Haiku/Gemini |
| Anything else | html | Firecrawl markdown extraction |

Failure modes (all hit in production at least once, all covered by tests in `tests/integration/url-ingest.test.ts`):

- Firecrawl returning `Example Domain` / 404 placeholder pages → reject content shorter than 300 chars or matching error titles
- xAI X-search returning miss responses (templated "I couldn't find...") → detect failure phrases and surface a clean `X_SEARCH_MISS:` error
- YouTube snowflake IDs vs xAI date windows → decode the post snowflake to derive a ±6h search window so xAI can find the post
- 240s Azure response timeout on chained fallbacks — server-side ingest still completes; client gets 504. Open task: convert URL ingest to async + 202/job_id polling.

---

## 7. Search

Implementation: `src/services/search.ts`, exposed via `POST /api/v1/search` and the MCP `search` tool.

### Inputs

```typescript
{
  query: string;
  project_id?: string;
  entity_types?: ('document' | 'note' | 'todo')[];
  tags?: string[];
  limit?: number;        // default 10
  threshold?: number;    // default 0.65 cosine similarity for vector path
  graph?: boolean;       // default true; pass false to disable graph expansion
  queryEntities?: Array<{name, type}>;   // pre-extracted; otherwise classifyQueryDepth() extracts on the fly
}
```

### Pipeline

```
1. Embed query (Gemini Embedding 2)
2. Vector seed: pgvector cosine scan against chunks + todos
   - Filtered by project_id, tags, entity_types, threshold
3. (If graph: true) Graph expansion:
   - For each query entity, find entities matching by canonical name / alias / embedding similarity
   - For each matched entity, fetch chunk_entities edges → expand to candidate chunks
   - Apply the SAME filters (project_id, tags, parent_type) on the expansion path's SQL
     (this was F2 — vector path filtered correctly, expansion didn't)
4. Reciprocal Rank Fusion (RRF, k=60) merges the two ranked lists
5. Annotate each hit with retrieval_path: [{step: 'vector', score}, {step: 'entity', entity, confidence}, ...]
```

Each hit returns `{type: 'chunk'|'todo', similarity, chunk?: {...}, todo?: {...}, retrieval_path: [...]}`. The web UI and RAG synthesizer both surface `retrieval_path` so users can see whether a hit came from cosine similarity, the entity graph, or both.

### `find_mentions` (graph-only)

`POST /api/v1/find-mentions` and MCP `find_mentions` — exact entity lookup. Resolves the input string against `entities` (canonical name OR any alias, case-insensitive), then returns every `chunk_entities` edge for that entity with the chunks attached. Used when you want "every doc that mentions pgvector" rather than "docs semantically related to pgvector."

---

## 8. RAG (`src/services/rag.ts`)

Question-answering over the corpus. Exposed via `POST /api/v1/rag` only (not in MCP — the MCP `search` tool is the building block; a client can synthesize on its own with the chunks).

### Pipeline

```
1. Resolve depth + query entities
   - depth: 'fast' | 'thorough' | 'auto'
   - 'auto' → run classifyQueryDepth (Haiku) → returns {depth, reason, entities}
   - 'fast'|'thorough' → skip classifier (zero classify_ms), no entity extraction
2. searchWithTimings (same path as REST /search) → top N chunks + retrieval_path per hit
3. Build context: numbered passages, source URL inline if present
4. Synthesize:
   - depth === 'thorough' → ragDeepLLM (gpt-5-4-pro Responses API) with reasoning
   - else → ragFastLLM (gpt-5-4 chat completions)
5. Return answer + citations + meta.timings_ms (classify, embed, db_scan, graph, synthesize, total)
```

### Default depth: `fast` (commit `a355ca6`)

Why this matters: a baseline profile (`docs/profiles/2026-04-25-rag-effort-baseline.md`) showed the reasoning model paying **22-36× the latency for marginal-to-zero quality gain** on retrieval-grounded queries. The classifier was routing ~half the queries to thorough; defaulting to fast cuts p95 latency dramatically without measurable quality loss. `auto` and `thorough` remain available as opt-in via the `depth` body parameter. The classifier code stays — it's still useful for query-entity extraction.

### Reasoning effort

`POST /api/v1/rag` accepts `reasoning_effort: 'low' | 'medium' | 'high'` — only meaningful when `depth === 'thorough'`. Plumbed through `LLMOptions` to `AzureFoundryResponsesProvider`. **`gpt-5-4-pro` rejects `'low'`** with HTTP 400 (`"param": "reasoning.effort"`) — only `medium` (default) and `high` work. Newer models may expose more effort levels; re-test on swaps.

---

## 9. Entity Graph Layer

Migration `003_entities_graph.sql` introduced two tables: `entities` (canonical names + aliases + embedding) and `chunk_entities` (many-to-many edges with confidence). This is the layer that lets the system "expand" a vector hit along entity edges — recovering recall lost by not running HNSW.

### Resolution algorithm (`src/services/entities.ts`)

```
For each entity returned by Haiku:
  1. Try exact-name match against entities.canonical_name (case-insensitive)
  2. Try alias match against entities.aliases (case-insensitive)
  3. Embed the canonical name and search by cosine similarity ≥ 0.85
  4. If still unresolved, INSERT new entity (with embedded canonical name)
```

### Edges (`chunk_entities`)

After resolving each entity, the service maps Haiku's mention strings to chunks via verbatim string search (`chunk.content.includes(mention)`). One edge per matching chunk.

A **surface-fallback sweep** runs after the primary mapping: for every chunk that verbatim-contains the canonical name or any alias but doesn't already have an edge to that entity, the service adds the edge with a slightly lower confidence. This catches chunks that Haiku didn't quote in its top-5 mentions per entity — a critical fix for multi-chunk docs where Haiku's mention list is necessarily sparse. Lowered the extraction threshold to 30 chars at the same time so image OCR (typically 79 chars) and audio transcription (typically 81 chars) don't get skipped silently.

Backfill endpoint (`POST /api/v1/diagnostics/backfill-entities`) re-runs extraction across existing chunks. Used when the pipeline changes mid-corpus.

### Diagnostics

- `GET /api/v1/diagnostics/entities` — list registered entities + counts
- `GET /api/v1/diagnostics/content/:id/edges` — show chunks + edge counts for a single content item
- `POST /api/v1/diagnostics/backfill-entities` — sweep existing chunks

These exist because Postgres is firewalled in production — direct `psql` from a laptop times out. The diagnostics endpoints are the way to introspect graph state.

---

## 10. MCP Server (`src/mcp/server.ts`)

Stateless HTTP. The server constructs a fresh `McpServer` + `WebStandardStreamableHTTPServerTransport` per request — no session state between requests. Auth via `Authorization: Bearer ...` header or `?key=...` query parameter (same key as REST).

The server passes a long `INSTRUCTIONS` string to clients that support it (Claude.ai, Claude Desktop, Claude Code). It tells the AI to scope project queries, prefer `search` before answering from training, dedup before creating, and never invent UUIDs.

### 8 tools

| # | Tool | What it does |
|---|------|-------------|
| 1 | `list_projects` | List all projects (filter by status optional) |
| 2 | `create_project` | Create a project |
| 3 | `list` | Browse with `entity_type` filter (`document` / `note` / `todo`) + project filter |
| 4 | `get` | Fetch by UUID — auto-detects entity type (project / content / todo) |
| 5 | `create` | Discriminated union over `document` / `note` / `quick_note` / `todo` |
| 6 | `search` | Hybrid vector + graph semantic search; returns `retrieval_path` per hit |
| 7 | `find_mentions` | Exact entity lookup (canonical name or alias) → list of chunks |
| 8 | `save_from_url` | Ingest by URL (YouTube / X / PDF / HTML / direct media) |

**No `update_*` or `delete_*` MCP tools.** Edits and deletes go through the web UI (or REST). Rationale: AI clients should be additive about a user's knowledge base — let the human curate destructive ops.

---

## 11. REST API

Defined in `src/app.ts`. Auth: `Authorization: Bearer <api-key>` or `?key=<api-key>` (same key as MCP).

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | `{"ok":true,"service":"open-brain","version":"2.0.0"}` (no auth) |
| GET / POST / PUT / DELETE | `/api/v1/projects[/:id]` | Project CRUD |
| POST | `/api/v1/projects/:id/restore` | Unarchive |
| GET / POST / PUT / DELETE | `/api/v1/content[/:id]` | Content item CRUD (POST accepts JSON or `multipart/form-data` with `file` field) |
| POST | `/api/v1/content/from-url` | URL ingestion |
| POST | `/api/v1/content/:id/restore` | Unarchive |
| GET / POST / PUT / DELETE | `/api/v1/todos[/:id]` | Todo CRUD |
| POST | `/api/v1/todos/:id/restore` | Unarchive |
| GET / POST / PUT / DELETE | `/api/v1/todos/:id/comments[/:cid]` | Todo comments CRUD |
| POST | `/api/v1/search` | Hybrid vector + graph search |
| POST | `/api/v1/find-mentions` | Exact entity lookup |
| POST | `/api/v1/rag` | RAG Q&A (`depth: 'auto' | 'fast' | 'thorough'`, `reasoning_effort: 'low' | 'medium' | 'high'`) |
| GET | `/api/v1/diagnostics/entities` | List entities |
| GET | `/api/v1/diagnostics/content/:id/edges` | Per-content graph introspection |
| POST | `/api/v1/diagnostics/backfill-entities` | Re-run entity extraction |
| ALL | `/mcp` | Stateless MCP — fresh server + transport per request |

Soft delete by default (`archived = true`); `?hard=true` deletes permanently. The `restore` endpoints flip `archived` back.

`/api/v1/content` GET / list / update endpoints route their `blob_url` field through `stripAndSignContent()` before responding — produces a SAS-signed URL with default 60-min TTL via `BlobStorage.getReadSasUrl()`. URLs that are empty, external, or already signed pass through unchanged.

---

## 12. Provider Abstraction

`src/providers/types.ts` defines the two interfaces every model client implements:

```typescript
interface EmbeddingProvider {
  embed(content: string, files?: Array<{ data: Buffer; mimeType: string }>): Promise<number[]>;
  readonly dimensions: number;  // 3072
}

interface LLMProvider {
  complete(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;
}
// LLMOptions: maxTokens, temperature, systemPrompt, responseFormat, reasoningEffort
// LLMResponse: content, tokensUsed: { input, output, reasoning?, total }
```

### Implementations

| Class | File | Default model |
|-------|------|---------------|
| `GeminiEmbeddingProvider` | `gemini-embedding.ts` | `gemini-embedding-2-preview` (3072d, multimodal) |
| `GeminiLLMProvider` | `gemini-llm.ts` | constructor takes default model — used for `gemini-3-flash-preview` audio/video metadata |
| `AnthropicLLMProvider` | `anthropic-llm.ts` | `claude-haiku-4-5-20251001` |
| `AzureFoundryLLMProvider` | `azure-foundry-llm.ts` | chat completions; `gpt-5-4` |
| `AzureFoundryResponsesProvider` | `azure-foundry-responses.ts` | Responses API; `gpt-5-4-pro` (reasoning support) |

All four LLM providers were instrumented in commit `e5133dc` to log per-call latency + tokens (input / output / reasoning / visible) and `output_items` breakdown for the Responses API. Use these to triage RAG latency without redeploying.

### `extractJson()` (`src/providers/json-utils.ts`)

LLMs sometimes wrap JSON in markdown fences ` ```json ... ``` ` even with `responseFormat: 'json'`. `extractJson()` strips wrapping in three passes:

1. Trim and check if already valid JSON (starts with `{` or `[`)
2. Match a `` ```json ... ``` `` block
3. Find first `{` / `[` and extract to matching close

Every LLM-JSON path in the service layer routes through this. When you add a new JSON-returning call, route it too.

### PDF parsing (`src/providers/pdf-extract.ts`)

`pdf-parse` v2 ships a `PDFParse` class — the v1 default-import function is gone. `sanitizeControlChars()` strips NUL/FF/VT bytes that `pdf-parse` occasionally leaks into extracted text (those would otherwise break strict JSON parsers like jq downstream).

---

## 13. Infrastructure

### Bicep modules (`infra/`)

| Module | Resource |
|--------|----------|
| `modules/container-app.bicep` | Hosts API + MCP + web UI. `minReplicas: 1` (always-on). Managed identity for ACR pull. |
| `modules/postgresql.bicep` | PostgreSQL Flexible Server (B1ms, pgvector enabled) |
| `modules/storage.bicep` | Blob Storage account + container; `Allow Blob Public Access = false` |
| `modules/keyvault.bicep` | All secrets (db connection string, API keys) |
| `modules/monitoring.bicep` | Log Analytics + Application Insights |
| `modules/function-app.bicep` | **Legacy** — pre-pivot consolidation timer trigger; now deploys a no-op (see §16) |

### Why ACR role assignment is CLI-only

The shared ACR lives in `shared-rg`; the Container App lives in `openbrain-rg`. Cross-resource-group role assignment can't be expressed in Bicep at resource-group scope, so SETUP.md does it via `az role assignment create` after Bicep deploys.

### Auto-migration on startup

`runMigrations()` in `src/server.ts` is the canonical migration path. It probes for table/column existence and applies any missing migrations. Idempotent — safe to restart the container any number of times. The Postgres pool is the raw `pg.Pool` (not the pgvector-typed client) so it works before the `vector` extension is registered.

### CI/CD (`.github/workflows/`)

- **`ci.yml`** (PR + push to main): `npm ci`, `tsc --noEmit`, `npm test`, `cd web && npm ci && npm run build`. `GEMINI_API_KEY` is exposed for any tests that hit real Gemini integration paths (most tests use mocks; very few hit the real API).
- **`deploy.yml`** (push to main): OIDC auth → build Docker image with `${{ github.sha }}` tag → push to ACR → `az containerapp update --image ...`. Also runs `Azure/functions-action` to publish the legacy consolidation function (cleanup pending — see §16).

CI and Deploy run independently. CI passing while Deploy fails (and vice versa) is possible. Always check both.

---

## 14. Testing

Vitest. **88 tests across 16 files** (as of 2026-04-25). One vitest config (`vitest.config.ts`) for unit + integration; a separate `vitest.e2e.config.ts` exists but the `tests/e2e/` folder it points at is currently unused — the `tests/integration/` files already exercise the full app surface against mocked providers and an in-memory test pg, which is what's actually being run in CI.

| Layer | Path | What it tests |
|-------|------|---------------|
| Unit | `tests/unit/capture/` | Mime utilities, URL detection |
| Unit | `tests/unit/db/` | Db client (pgvector type registration on first use) |
| Unit | `tests/unit/mcp/` | MCP server tool wiring |
| Unit | `tests/unit/providers/` | Anthropic, Gemini, embedding, PDF extraction, error paths |
| Unit | `tests/unit/services/` | Search filter parity (F2 regression), entity mapping (F3) |
| Unit | `tests/unit/storage/` | Blob client (incl. SAS signing for T3.5 fix) |
| Integration | `tests/integration/rest-api.test.ts` | All REST endpoints against mocked deps |
| Integration | `tests/integration/mcp-integration.test.ts` | MCP tool surface end-to-end |
| Integration | `tests/integration/url-ingest.test.ts` | URL classification + fetcher routing (mocked YouTube/Firecrawl/xAI) |
| Integration | `tests/integration/archive-delete.test.ts` | Soft- and hard-delete flows |

Mocks live in `tests/helpers/mocks.ts`. New behavior gets a test at the appropriate layer; bug fixes get a regression test at the lowest layer that would have caught them.

For full live-system validation, see `E2E_TEST_PLAN.md` — 52 reproducible tests across 10 phases that hit production. Not part of the automated suite (LLM nondeterminism + cost + needs the owner's API key).

---

## 15. Known Limitations & Gotchas

### LLM/JSON

- **Markdown-fenced JSON.** Anthropic and Gemini both ignore `responseFormat: 'json'` occasionally. Always run JSON output through `extractJson()`. Adding a new LLM-JSON path? Route it.
- **Output token budget.** Haiku metadata calls use `maxTokens: 8192` for PDF-scale inputs (the default 2048 truncates real PDFs). Entity extraction caps input at 50K chars and uses 4096.
- **Reasoning model effort levels.** `gpt-5-4-pro` rejects `reasoning_effort: 'low'` (HTTP 400). Only `medium` and `high` work. Newer models may expose more — re-test.

### Embeddings

- **Gemini Embedding 2 default dim is 768.** We explicitly request 3072. Verify in `src/providers/gemini-embedding.ts` if you ever change provider.
- **Multimodal MIME whitelist** for embedding: `image/png`, `image/jpeg`, `audio/mpeg`, `audio/wav`, `video/mp4`, `video/quicktime`, `application/pdf`. Anything else needs to be converted upstream.
- **Generative Language API must be enabled** on the GCP project tied to the API key. Otherwise: `API has not been used in project ... or it is disabled`.

### PostgreSQL

- **`db.query()` calls `ensureVector()`** which lazily registers pgvector types on first use. Migrations creating the `vector` extension must use `pool.query()` directly (chicken-and-egg).
- **No HNSW.** B1ms can't allocate `maintenance_work_mem` for HNSW init at 3072 dims. Sequential scan is the cost.
- **Postgres firewall.** Production DB rejects connections from the open internet. Use `/api/v1/diagnostics/*` endpoints for graph introspection — `psql` from a laptop will time out.

### Azure

- **240s response timeout on Container App.** URL ingestion can exceed this when fallbacks chain. Server completes the work; client gets 504. Open task: convert URL ingest to async + 202/job_id polling.
- **Image tag uniqueness for revisions.** Container Apps only creates a new revision when the image *reference* changes. Push under git SHA tags, not just `:latest`.
- **Cross-RG role assignment must be CLI.** ACR lives in `shared-rg`; Container App in `openbrain-rg`. Bicep at RG-scope can't express it.
- **Apple Silicon platform flag.** `docker build --platform linux/amd64`. Default arm64 won't run on Azure x86-64.

### URL ingest

- **YouTube: tries direct → Firecrawl → xAI.** Only succeeds when one returns a real transcript.
- **X/Twitter: xAI Grok primary, Firecrawl stealth fallback.** Detect xAI miss responses up front to surface a clean `X_SEARCH_MISS:` error.
- **HTML: Firecrawl markdown.** Reject content shorter than 300 chars or matching error/placeholder titles.
- **Dedup is by source_url first, then file_hash for binary downloads.**

### Search / RAG

- **Filter parity on graph expansion.** The vector-seed path filters via `findSimilarChunks`; the graph-expansion path's separate SQL must include the same project/tags/parent_type filters. Was F2 — leaked untagged chunks at sim=1.0 if you forgot. Tests in `tests/unit/services/search.test.ts` lock this in.
- **Entity threshold is 30 chars.** Was 100 originally and silently skipped image OCR (~79 chars) and audio transcription (~81 chars). Was F3 — fixed in commit `c9acd89`.

---

## 16. Legacy Infrastructure (cleanup candidates)

Things still deployed but **not used** by the V2 app. Slated for removal on a quiet day. Listed here so future-you doesn't trip over them.

| Item | Why it's still there | When to remove |
|------|---------------------|----------------|
| `infra/modules/function-app.bicep` | Pre-pivot consolidation timer trigger | After confirming nothing in production points at it |
| `functions/consolidation-trigger/` | Pre-pivot Azure Function source | With the Bicep module |
| `Azure/functions-action` step in `deploy.yml` | Publishes the no-op function on every deploy | With the Bicep module |
| `psql ... migrations/001_initial_schema.sql` step in `scripts/deploy.sh` | References a migration filename that no longer exists | Anytime — auto-migration on startup is the real path |
| `telegramBotToken` / `telegramWebhookSecret` / `telegramChatId` Bicep params | Pre-pivot Telegram bot | After updating Bicep schema (no V2 code reads these) |
| `consolidationSchedule` Bicep param | CRON for the no-op function | With the function-app module |

When you do the cleanup, also strip references from `SETUP.md`, this doc, and any handoff docs in `docs/`.

---

## 17. File Map

```
open-brain-v2/
├── src/
│   ├── server.ts                       Entry point: deps wiring + migrations + serve
│   ├── app.ts                          Hono app: REST routes + MCP mount + static web
│   ├── config.ts                       Zod-validated env config
│   ├── capture/
│   │   ├── chunker.ts                  500/100 sliding window with sentence-boundary alignment
│   │   ├── ingest-trace.ts             Per-ingest trace IDs + fingerprints
│   │   ├── metadata.ts                 Haiku metadata: title, topics, tags, extracted_text, published_at
│   │   ├── mime-utils.ts               inferMimeFromFilename, resolveUploadMime
│   │   └── url-detect.ts               Classify URL type (YouTube, X, PDF, image, audio, html)
│   ├── db/                             Raw SQL, no ORM. One module per table.
│   │   ├── client.ts                   pg.Pool wrapper that registers pgvector types on first use
│   │   ├── projects.ts
│   │   ├── content-items.ts
│   │   ├── chunks.ts
│   │   ├── todos.ts
│   │   ├── todo-comments.ts
│   │   └── entities.ts                 entities + chunk_entities edges
│   ├── services/                       Business logic. Adapters call into here.
│   │   ├── index.ts                    ServiceDeps interface (DI contract)
│   │   ├── projects.ts
│   │   ├── content-items.ts            Orchestrates dedup→upload→metadata→chunk→embed→graph
│   │   ├── todos.ts
│   │   ├── todo-comments.ts
│   │   ├── search.ts                   Hybrid vector + graph search with RRF fusion + retrieval_path
│   │   ├── rag.ts                      Q&A: depth classify → search → synthesize via fast or pro
│   │   ├── query-depth.ts              Haiku classifier: fast vs thorough + entity extraction
│   │   ├── entities.ts                 extract → resolve → map mentions to chunks → persist edges
│   │   └── url-ingest.ts               YouTube / X / PDF / HTML ingestion → content-items pipeline
│   ├── providers/
│   │   ├── types.ts                    EmbeddingProvider, LLMProvider interfaces
│   │   ├── gemini-embedding.ts
│   │   ├── gemini-llm.ts
│   │   ├── anthropic-llm.ts
│   │   ├── azure-foundry-llm.ts        Chat completions (gpt-5-4)
│   │   ├── azure-foundry-responses.ts  Responses API (gpt-5-4-pro) with reasoning support
│   │   ├── pdf-extract.ts              pdf-parse v2 PDFParse class + control-char sanitizer
│   │   ├── youtube-transcript.ts
│   │   ├── firecrawl.ts                HTML extraction fallback
│   │   ├── xai.ts                      X/Twitter live-search via Grok
│   │   └── json-utils.ts               extractJson() — strips markdown fences from LLM output
│   ├── mcp/
│   │   └── server.ts                   8 MCP tools + INSTRUCTIONS string
│   └── storage/
│       └── blob.ts                     Azure Blob upload/download + getReadSasUrl
├── migrations/
│   ├── 001_schema.sql                  projects, content_items, chunks, todos, todo_comments
│   ├── 002_source_url.sql              source_url column on content_items
│   └── 003_entities_graph.sql          entities, chunk_entities, published_at
├── infra/
│   ├── main.bicep                      Top-level template
│   ├── parameters.json                 Non-secret values
│   └── modules/
│       ├── container-app.bicep         Container App (minReplicas: 1, managed identity)
│       ├── postgresql.bicep            Flexible Server (B1ms, pgvector)
│       ├── storage.bicep               Blob storage (private)
│       ├── keyvault.bicep              All secrets
│       ├── monitoring.bicep            Log Analytics + App Insights
│       └── function-app.bicep          [LEGACY — see §16]
├── functions/
│   └── consolidation-trigger/          [LEGACY — see §16]
├── scripts/
│   ├── deploy.sh                       Manual deploy (has stale migration step — see §16)
│   ├── migrate-azure.sh                Manual psql against Azure (rarely needed; auto-migration is canonical)
│   ├── backfill-entities.ts            Bulk re-run entity extraction
│   ├── cleanup-stale-ingests.ts
│   └── rag-profile.sh                  Reproducible RAG latency/quality profile
├── web/                                Vite + React + Tailwind UI (built into web/dist, served by Hono)
├── tests/
│   ├── helpers/
│   │   └── mocks.ts                    Shared mock factories
│   ├── unit/
│   │   ├── capture/                    mime-utils, url-detect
│   │   ├── db/                         client
│   │   ├── mcp/                        server
│   │   ├── providers/                  anthropic-llm, gemini-embedding, gemini-llm, pdf-extract, provider-errors
│   │   ├── services/                   entities, search
│   │   └── storage/                    blob
│   └── integration/
│       ├── archive-delete.test.ts
│       ├── mcp-integration.test.ts
│       ├── rest-api.test.ts
│       └── url-ingest.test.ts
├── docs/
│   ├── handoffs/                       Session handoff docs
│   └── profiles/                       Reproducible benchmark baselines (e.g., RAG effort)
├── .github/workflows/
│   ├── ci.yml                          Typecheck + tests on PR/push
│   └── deploy.yml                      Build, push, deploy on push to main (OIDC)
├── docker-compose.yml                  Local Postgres on port 5434
├── Dockerfile                          Multi-stage build
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── vitest.e2e.config.ts                (currently unused; tests/e2e/ folder is empty)
├── README.md                           Project overview + local dev setup
├── SETUP.md                            First-time Azure deployment walkthrough
├── ARCHITECTURE.md                     This doc
├── CLAUDE.md                           Instructions for AI sessions in this repo
└── E2E_TEST_PLAN.md                    52-test reproducible live-system validation
```

---

## 18. Environment Variables

Validated by `loadConfig()` in `src/config.ts` on startup. All required values throw a clear Zod error if missing.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `OPEN_BRAIN_API_KEY` | Yes | — | API key for REST + MCP auth |
| `AZURE_STORAGE_CONNECTION_STRING` | Yes | — | Blob Storage connection string |
| `AZURE_STORAGE_CONTAINER` | Yes | — | Blob container name |
| `GEMINI_API_KEY` | Yes | — | Google Gemini API key (embeddings + audio/video metadata) |
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key (Haiku for metadata, entity extraction, query depth) |
| `XAI_API_KEY` | Yes | — | xAI API key (X/Twitter live search via Grok) |
| `FIRECRAWL_API_KEY` | Yes | — | Firecrawl API key (HTML extraction fallback) |
| `AZURE_OPENAI_ENDPOINT` | Yes | — | Azure Foundry / Azure OpenAI endpoint URL |
| `AZURE_OPENAI_KEY` | Yes | — | Azure Foundry / Azure OpenAI key |
| `AZURE_RAG_DEPLOYMENT` | No | `gpt-5-4` | Deployment name for fast-path RAG (chat completions) |
| `AZURE_DEEP_RAG_DEPLOYMENT` | No | `gpt-5-4-pro` | Deployment name for thorough-path RAG (Responses API) |
| `PORT` | No | `3000` | HTTP server port |
| `NODE_ENV` | No | `development` | `development` / `production` / `test` |
| `TIMEZONE` | No | `America/Chicago` | IANA timezone (date math) |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | No | — | Set automatically by Azure when App Insights is wired |

No `TELEGRAM_*` env vars are read by V2 code. Bicep parameters of those names are vestigial — see §16.
