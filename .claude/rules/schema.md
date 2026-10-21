---
paths:
  - "migrations/**"
  - "backend/src/db/**"
---

# Schema & database rules

Loads when touching `migrations/` or `backend/src/db/`. Migration list, pgvector handling, B1ms / HNSW constraint.

## Migrations (13 total)

- `001_schema.sql` — projects, content_items, chunks, todos, todo_comments
- `002_source_url.sql` — adds `source_url` column to content_items for URL-ingested content
- `003_entities_graph.sql` — entities, chunk_entities, `published_at` column on content_items
- `004_processing_status.sql` — `processing_status` (pending/ready/failed) + `processing_error` on content_items for the async ingest contract
- `005_backfill_control_chars.sql` — strip C0/DEL bytes from old content_items.content rows
- `006_ingest_completed_at.sql` — `ingest_completed_at` for the polling endpoint
- `007_pinned.sql` — nullable `pinned_at` TIMESTAMPTZ on content_items, todos, projects, with partial indexes
- `008_manual_order.sql` — nullable INTEGER `manual_order` on todos for user-defined sort within sibling groups
- `009_content_folder.sql` — nullable `folder` TEXT on content_items (single hierarchical path, e.g. `cooking/italian`) — the first-class field behind the Notes-view folder tree. **Folders are separate from tags now**: a single-segment path like `travel` is a valid top-level folder. Backfills existing rows by moving the first slash-containing tag into `folder` and stripping slash-tags out of `tags`. **Insert param order shifted** — `folder` is `$10`, so source_url/published_at/processing_status moved to `$13/$14/$15`.
- `010_subtask_tags_cleanup.sql` — idempotent backfill clearing `tags` on subtasks (`parent_id IS NOT NULL`). Tags are **root-only**: enforced on create/update (service) + bulk-add (`AND parent_id IS NULL`); this strips legacy subtask tags. Probe runs only while offending rows exist.

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


- `011_project_memory.sql` creates `project_sessions` and project memory storage.
- `012_project_timeline.sql` creates transactional timeline capture and reconstructs known legacy creation/latest-edit timestamps.
- `013_session_workspaces.sql` makes sessions standalone or project-owned, adds names and ownership FKs, derives artifact project membership, propagates task/session moves, and queues original-file cleanup. All new migrations have startup probes in `server.ts`. Existing embedding dimensions remain 3072.
