---
paths:
  - "migrations/**"
  - "backend/src/db/**"
---

# Schema & database rules

Loads when touching `migrations/` or `backend/src/db/`. Migration list, pgvector handling, B1ms / HNSW constraint.

## Migrations (8 total)

- `001_schema.sql` — projects, content_items, chunks, todos, todo_comments
- `002_source_url.sql` — adds `source_url` column to content_items for URL-ingested content
- `003_entities_graph.sql` — entities, chunk_entities, `published_at` column on content_items
- `004_processing_status.sql` — `processing_status` (pending/ready/failed) + `processing_error` on content_items for the async ingest contract
- `005_backfill_control_chars.sql` — strip C0/DEL bytes from old content_items.content rows
- `006_ingest_completed_at.sql` — `ingest_completed_at` for the polling endpoint
- `007_pinned.sql` — nullable `pinned_at` TIMESTAMPTZ on content_items, todos, projects, with partial indexes
- `008_manual_order.sql` — nullable INTEGER `manual_order` on todos for user-defined sort within sibling groups

Auto-migration runs on container startup (`runMigrations()` in `backend/src/server.ts`). It checks for table/column existence and applies missing migrations idempotently. Adding a new migration: add the file under `migrations/` AND add a new existence probe in `runMigrations()` — without the probe the new migration won't be auto-applied.

## pgvector

- `db.query()` calls `ensureVector()` which lazily registers pgvector types on first use. **Migrations that create the `vector` extension must use `pool.query()` directly (not `db.query()`)** to avoid the chicken-and-egg: ensureVector wants the extension to already exist.
- HNSW is **not** in use. B1ms tier doesn't have the memory for HNSW init at 3072 dims (we tried; it OOMs). Sequential scan is fine at single-user scale — well under 100ms per query for the current corpus. Don't try to add an HNSW index unless you also plan to upsize the DB tier or drop the embedding dim.
- Embeddings are 3072 dim (Gemini Embedding 2, multimodal). pg `vector(3072)` column.

## DB client (`backend/src/db/client.ts`)

`pg.Pool` wrapper. One method `query(sql, params)` that:
1. Calls `ensureVector()` on first use to register pgvector serializers/deserializers
2. Forwards to `pool.query`

Per-table modules under `backend/src/db/` import the client and own their SQL. No ORM. Keep raw SQL in these files; services compose them.
