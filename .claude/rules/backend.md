---
paths:
  - "backend/**"
---

# Backend rules — Hono API + MCP server

Loads when working in `backend/`. Service layer pattern, MCP tools, project membership, search/RAG behavior, backend test layout.

## Backend layout (everything under `backend/src/`)

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
│   ├── supadata.ts         # YouTube transcript via Supadata (single-call, no fallback)
│   ├── firecrawl.ts        # HTML extraction
│   ├── xai.ts              # X/Twitter live-search via Grok
│   ├── stub.ts             # Deterministic in-memory LLM/embedding fakes for stub mode
│   └── json-utils.ts       # extractJson() — strips markdown fences from LLM output
├── mcp/
│   └── server.ts           # 21 MCP tools (see below)
└── storage/
    └── blob.ts             # Azure Blob upload/download
```

## Service layer pattern

Adapters (REST in `app.ts`, MCP in `mcp/server.ts`) are thin: parse input → call a service function → format response. **All business logic lives in `backend/src/services/`.** Service functions take `ServiceDeps` (the DI container with db, providers, blob, config) as their first argument. Direction of dependency: adapters → services → db/providers. Never import adapter code from services.

## MCP tools (21 total — defined in `backend/src/mcp/server.ts`)

Read:
1. `list_projects` — list all (filter by status optional)
2. `list` — entity_type-filtered browse (document / note / todo)
3. `get` — fetch by UUID, auto-detects type (project / content / todo)
4. `search` — hybrid vector + graph semantic search, RRF-fused, with `retrieval_path` per hit
5. `find_mentions` — exact entity lookup (canonical name or alias) → list of chunks
6. `list_tags` — tag inventory with usage counts; optional `project_id` scope
7. `list_comments` — comments on a todo
8. `list_activity` — recent ingest / edit / comment events with since/until/kinds/project_id filters
9. `ask` — RAG synthesis (auto / fast / thorough depth)

Write:
10. `create_project`
11. `create` — discriminated union over document / note / quick_note / todo (todo gets `parent_id` and `section`; document/note/quick_note accept an optional `folder` path)
12. `update` — metadata edits across kinds: todo (status/priority/due/parent/tags/project), content (title/project_ids/tags/**folder** — single hierarchical path, null to unfile), project (name/description/status)
13. `replace` — archive an existing content item and create a v2 in its place; old row stamped `metadata.replaced_by`. Refuses pending rows. Text-only (REST handles binary replacement).
14. `archive` — soft delete on content / todo / project
15. `restore` — undo `archive`
16. `add_comment` — add a comment to a todo
17. `update_comment` — edit a comment body
18. `save_from_url` — ingest by URL (YouTube / X / PDF / HTML / direct media)
19. `retry` — re-run a failed ingest (state must be `failed`)
20. `reprocess` — regenerate chunks/embeddings/metadata on a healthy or failed row (NOT pending)
21. `rename_tag` — corpus-wide tag rename (also handles delete via collapse-to-existing)

Hard delete is REST-only by design. Bulk ops, pin/unpin, and stats are REST-only — those are UI affordances rather than AI workflows. The MCP server passes a long `INSTRUCTIONS` string to clients telling the AI to scope project queries, prefer `search` before answering from training, dedup before creating, and never invent UUIDs.

## Project membership (asymmetric — easy to get wrong)

| Entity | Membership field |
|--------|------------------|
| document, note, quick_note | `project_ids[]` (array, multi-project) |
| todo | `project_id` (single string, nullable = personal Inbox) |

Mixing them up will make the call fail.

## Search and RAG behavior

- `search()` returns hits with a `retrieval_path` array showing which path (vector / entity expansion / both) reached the chunk. RRF fusion combines the lists. `graph: false` opts out of expansion.
- `ragQuery()` first runs the depth classifier (Haiku) which both classifies fast/thorough AND extracts named entities to seed graph expansion. `depth: 'fast'|'thorough'` skips the classifier (zeroes its timing).
- Per-stage timing is on every RAG response (`meta.timings_ms`). Use it to diagnose latency.

## Test layout

| Layer | Path | What |
|-------|------|------|
| Unit | `backend/tests/unit/**` | Single modules: providers, db client, mcp server wiring, capture utilities, storage |
| Integration | `backend/tests/integration/rest-api.test.ts` | All REST endpoints against mocked deps |
| Integration | `backend/tests/integration/mcp-integration.test.ts` | MCP tool surface end-to-end |
| Integration | `backend/tests/integration/url-ingest.test.ts` | URL classification + fetcher routing (mocked YouTube/Firecrawl/xAI) |
| Integration | `backend/tests/integration/archive-delete.test.ts` | Soft- and hard-delete flows |

Mocks live in `backend/tests/helpers/mocks.ts`. Add new tests at the appropriate layer when you change behavior. Bug fixes get a regression test.

Run a single backend file (from `backend/`):
```bash
cd backend && npx vitest run tests/integration/rest-api.test.ts
```
