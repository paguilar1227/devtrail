# MCP and REST API Parity

> **Status: SHIPPED 2026-04-30.** Tasks #60-#76 all merged and live on prod. The MCP surface is now 20 tools; REST has bulk ops, status polling, retry, reprocess, tags inventory + rename, activity feed, stats, and pin/unpin across content/todos/projects. CLAUDE.md and the MCP INSTRUCTIONS string have been refreshed to reflect the surface. Task #77 (document replacement workflow + light versioning) was deferred and remains pending.

Plan to finalize the MCP tool surface and the REST API before the V2 UI build. Goal isn't strict parity — it's both surfaces being **coherent and intentionally complete** so the UI has a stable contract to build against.

Anchor diagnosis (run on 2026-04-30): the MCP read+create asymmetry, async-ingest contract gaps, and several latent capabilities (tags, activity, stats, bulk ops, reprocess, pin) sit in services or aren't built at all. This plan covers all of them.

## A. Close MCP's read+create asymmetry

### A1. `update` tool — discriminated over todo / content metadata / project (Task #60)
Add a discriminated-union `update` tool to MCP, mirroring the shape of `create`. Three branches:
- **todo:** status (mark done / in_progress / paused), priority, due_date, content, parent_id, section, tags
- **content:** title, project_ids, tags. For `type='note'` also content body (which re-chunks + re-embeds). Documents stay metadata-only since the body is external reference material.
- **project:** name, description, status

Closes the biggest MCP read/create asymmetry — today an AI can't even mark a todo done. Implementation: thin tool wrapping existing `services/{todos,content-items,projects}.update*`. Update the MCP `INSTRUCTIONS` so AIs know the gating rules (notes are body-mutable, documents aren't).

### A2. Todo comments — `add_comment`, `list_comments`, `update_comment` (Task #61)
Comments are REST-only today and invisible to AI sessions, which means an AI can't read prior context on a thread before suggesting next steps and can't leave a triage trail. Three tools:
- `add_comment(todo_id, content)`
- `list_comments(todo_id)`
- `update_comment(comment_id, content)`

No delete via MCP (keep destructive ops UI-only). Wraps existing `services/todo-comments.ts`. Add concrete examples to `INSTRUCTIONS` for "I noticed this is blocked on X" style trails.

### A3. `archive` and `restore` tools (Task #62)
Soft-delete + undo for content / todo / project. Two tools:
- `archive(id)` — auto-detects entity type via the same probe `get` uses (content → todo → project)
- `restore(id)` — same auto-detection

Keeps MCP non-destructive (hard delete stays UI-only) but lets an AI clean up when the user says "scrap that note." Wraps existing service archive/restore methods. Note in `INSTRUCTIONS` that these are reversible and that hard delete still requires the UI.

### A4. `create` — add `parent_id` + `section` to todo branch (Task #63)
REST `POST /todos` already accepts both fields; MCP `create` doesn't, so any todo hierarchy an AI builds is flat. Small additive change: extend the zod schema for the todo branch of `create`, plumb both through to `todosSvc.createTodo` (which already takes them). Update tool description with a concrete subtask example.

## B. RAG over MCP

### B1. `ask` tool — RAG synthesis (Task #64)
Wrap `POST /api/v1/rag` as an MCP tool. Returns synthesized answer + citations, not raw chunks. Args: `question, project_id?, depth: 'auto'|'fast'|'thorough'?, tags?, entity_types?, max_chunks?`.

Use case: when the user wants a thorough cited summary, the gpt-5-pro thorough path beats Claude synthesizing from raw search hits. Optional from a Claude perspective (good clients can synthesize from `search`), but valuable for thorough multi-hop summaries and for thinner clients (mobile, non-Claude). Document in `INSTRUCTIONS` when to prefer `ask` vs `search`.

## C. Async ingest formalization

### C1. `GET /content/:id/status` — dedicated polling endpoint (Task #65)
Cheap polling for async ingest. Returns just `{ id, status, processing_error, ingest_started_at, ingest_completed_at, chunk_count }` — no content body, no metadata, no embeddings.

Today the UI would have to refetch the whole row (with chunks/metadata) every tick to read `processing_status`. With multi-MB PDF rows that's expensive. Add `started_at` / `completed_at` columns to migration if not present (check current schema first). Sets up the contract the new UI will lean on heavily.

### C2. REST + MCP retry for failed ingests (Task #66)
`POST /api/v1/content/:id/retry` and MCP `retry` tool. Idempotent: sets row `processing_status` back to `pending`, re-runs `runIngestTail` on the existing row. Preserves dedup, source_url, tags, project membership.

Today the only recovery from a failed ingest is delete + recreate, which is bad UX (loses the existing id, breaks any inbound references) and impossible if the original source is no longer available (e.g., a file blob already uploaded). Wraps the same ingest tail used by `createContentItem`.

### C3. `GET /content` — `?processing_status=` filter (Task #67)
Add `processing_status` to the list query params. Accepts `pending|ready|failed` (or comma-separated). Powers "currently processing" and "failed ingests" UI views. Trivial DB filter, contract just isn't there today. Update `listContentItems` in `services/content-items.ts` and the corresponding integration test.

## D. Tag management

### D1. `GET /tags` + MCP `list_tags` (Task #68)
Returns `[{ name, total, by_type: { document, note, todo } }]`, sorted by total desc. Implementation: single SQL union over `content_items.tags` and `todos.tags` with `unnest` + `group by`. Powers tag-cloud / tag-picker UI components and lets AIs browse the user's taxonomy before re-tagging. Optional `?project_id=` to scope to one project.

### D2. Tag rename + delete (+ MCP `rename_tag`) (Task #69)
- `PUT /api/v1/tags/:name` body `{ to: string }` — renames the tag across `content_items.tags` and `todos.tags` in one transaction
- `DELETE /api/v1/tags/:name` — strips the tag from all rows (does NOT delete the rows themselves)
- MCP exposes `rename_tag` only — deletion is rare and UI-driven

Use case: settled on a taxonomy after the fact and need to migrate. Make sure both ops are case-insensitive on match, case-preserving on rename (use the new value as written).

## E. Activity feed

### E1. `GET /activity` + MCP `list_activity` (Task #70)
Chronological feed of recent changes. Query: `since`, `until`, `types[]` (`ingest|edit|complete|archive|comment`), `project_id`, `limit`.

V1 sourcing: derive from `created_at` / `updated_at` / `processing_completed_at` on existing tables (`content_items`, `todos`, `todo_comments`) — no separate event log table needed. Each row in the response: `{ at, kind, entity_type, entity_id, title, project_id }`.

Powers UI "recent" view, daily digest workflows, and AI "what did I do today" recaps. The recap use case alone is high-value.

## F. Stats / inventory

### F1. `GET /stats` (Task #71)
Aggregate counts and storage stats. Returns:
- total content items by type (`document`, `note`)
- total todos by status (`not_started`, `in_progress`, `paused`, `done`)
- total projects by status (`active`, `archived`, `completed`)
- top N projects by item count
- total blob storage bytes used (sum from `content_items` metadata)
- `last_ingested_at`, `last_edited_at`
- count of items in non-ready `processing_status`

REST-only (low MCP value). Powers UI home/dashboard. Single SQL with multiple subqueries or one CTE per metric.

## G. Bulk operations

### G1. `POST /content/bulk` — bulk content ops (Task #72)
Body: `{ ids: string[], op: 'archive'|'restore'|'tag-add'|'tag-remove'|'project-add'|'project-remove', value?: string|string[] }`.

Per-op semantics:
- archive/restore: no value
- tag-add/tag-remove: value is the tag string
- project-add/project-remove: value is the `project_id`

Single transaction, idempotent (e.g., tag-add on a row that already has the tag is a no-op). Returns `{ updated: number, skipped: number }`. Powers UI multi-select affordances. REST-only — AIs do these one at a time.

### G2. `POST /todos/bulk` — bulk todo ops (Task #73)
Body: `{ ids: string[], op, value? }` mirroring content bulk, plus:
- `status`: value is `not_started|in_progress|paused|done`
- `priority`: value is `P1|P2|P3|null`
- `due_date`: value is ISO 8601 or null

Closing 10 done todos shouldn't be 10 round-trips. REST-only.

## H. Reprocessing

### H1. `POST /content/:id/reprocess` + MCP `reprocess` (Task #74)
Generalized reprocessing endpoint. Body: `{ steps?: ['metadata','chunks','entities'] }`, default all three.

Per step:
- **metadata:** re-run `extractMetadata` on existing content (replaces title, topics, tags, extracted_text)
- **chunks:** re-chunk + re-embed (deletes old chunks, regenerates from current content body)
- **entities:** re-extract + re-resolve + rebuild edges (extends today's diagnostics `backfill-entities`)

Use cases: edited a note body and want fresh chunks; models improved and want better entities; entity extraction under-counted on this row. Set `processing_status='pending'` during the run and back to `'ready'` after. MCP twin lets AIs trigger it after noticing graph gaps.

## I. Pin / favorite

### I1. Schema + endpoints (Task #75)
Add `pinned BOOLEAN NOT NULL DEFAULT false` to `content_items` and `todos` via migration 006. Endpoints:
- `POST /api/v1/content/:id/pin` and `/unpin`
- `POST /api/v1/todos/:id/pin` and `/unpin`
- List filter `?pinned=true`

Search-boost for pinned items is deferred (not in this batch — measure first). MCP exposure is low priority; can ship REST-only initially. Surface in `list` ordering: pinned first, then by `updated_at desc`.

## J. Doc refresh

### J1. Refresh MCP `INSTRUCTIONS` + CLAUDE.md after surface lands (Task #76)
The MCP `INSTRUCTIONS` block in `src/mcp/server.ts` and the project `CLAUDE.md` both claim "no update or delete via MCP" and "documents are immutable after creation." Both will be wrong once A1–A4 + reprocess + retry land.

Sweep both docs:
- Update "Known limitations" section in MCP `INSTRUCTIONS`
- Update concrete examples to include update / comment / archive / ask flows
- Update `CLAUDE.md` "MCP tools" section
- `grep -rn` for any other doc that mentions the old surface

Last task in the batch — needs the new tools to be in place first.

## K. Deliberately NOT in this batch

- **Hard delete via MCP** — destructive ops stay UI-only
- **File upload via MCP** — `save_from_url` covers it; binary base64 over MCP isn't worth the protocol bloat
- **Webhooks / SSE** — overkill for single-user; polling is fine
- **Saved searches / smart filters** — wait for UI to surface the need
- **Editing document body content** — documents stay metadata-mutable only

## L. Document replacement + versioning (Task #77, deferred)

Decision from the 2026-05-02 discussion: when you have v2 of a doc, archive v1 and upload v2 as a new id. Both ops already exist; UI can wrap them in a single "Replace this doc" button later. Loses inbound references but in a single-user KB the impact is minimal.

Optional follow-up if forward/backward navigation between versions ever becomes valuable: add `superseded_by UUID NULL` column on content_items, populate it on the replace flow, filter superseded items from list/search by default. Buys 90% of versioning's value at ~10% of the cost.

Full versioning (versions table, branching, picker UI) is YAGNI for a personal KB and explicitly out of scope.

## Suggested execution order

1. **Async ingest formalization** — #65, #66, #67. Small, independent, completes the contract started by the async refactor. Foundation the UI needs.
2. **MCP write surface** — #60, #61, #62, #63. The big asymmetry close.
3. **UI-data surfaces** — #68, #69, #70, #71. Tags, activity, stats. Pure UI prerequisites.
4. **Bulk + reprocess + pin** — #72, #73, #74, #75. Power-user features; fine to slip if UI work needs to start sooner.
5. **MCP `ask`** — #64. Independent; slot anywhere.
6. **Doc refresh** — #76. Last, after the new tools are in place.
