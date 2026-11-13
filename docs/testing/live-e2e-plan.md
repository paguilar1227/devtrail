# DevTrail — E2E Manual Test Plan

End-to-end validation of the live production system: REST API, MCP server, search, RAG, graph, multimedia ingest, full CRUD, and cascade behavior.

Each test is self-contained — copy the curl, verify the pass criteria, check the box. Tests are sequenced so later ones depend on artifacts from earlier ones; don't reorder. If a test fails, stop and investigate before continuing.

---

## Reproducibility

Every input is pinned. Same inputs → same expected outcomes (within LLM nondeterminism, which is documented per test).

- **File fixtures** are checked in at `backend/tests/fixtures/e2e/` (PDF, PNG, WAV). Regenerate via instructions in `backend/tests/fixtures/e2e/README.md` if needed — but if you do, update the expected-outcomes section below.
- **URLs** are pinned to stable resources (an arXiv abstract from 2017, a TED talk that's been online for years, a long-stable blog post).
- **Inline content** for documents/notes/todos is hardcoded in the curl bodies. Don't edit it.
- **Test project name** uses a deterministic prefix (`E2E Test`) so cleanup can find leftovers from a crashed run.

If a test diverges from the expected outcome, that's the bug — investigate before re-running.

## Prerequisites

### Environment

```bash
cd devtrail   # repo root
export API="https://your-app.your-env.region.azurecontainerapps.io"
export KEY="$(az keyvault secret show --vault-name your-keyvault --name devtrail-api-key --query value -o tsv)"
export AUTH="Authorization: Bearer $KEY"
export CT="Content-Type: application/json"

# Pinned URL fixtures (stable for 5+ years)
export YT_URL="https://www.youtube.com/watch?v=8jPQjjsBbIc"   # TED talk, "Inside the mind of a master procrastinator" — Tim Urban — has transcript
export ARXIV_URL="https://arxiv.org/abs/1706.03762"            # "Attention Is All You Need" — Vaswani et al, 2017
export BLOG_URL="https://www.paulgraham.com/wealth.html"       # "How to Make Wealth" — Paul Graham — long-stable, no paywall

# Local file fixtures
export PDF_FILE="$PWD/backend/tests/fixtures/e2e/sample.pdf"
export IMG_FILE="$PWD/backend/tests/fixtures/e2e/sample.png"
export AUDIO_FILE="$PWD/backend/tests/fixtures/e2e/sample.wav"

# Sanity
curl -s "$API/health" | jq .
# expect: {"ok": true, "service": "devtrail", "version": "2.0.0"}

# Verify fixtures exist
for f in "$PDF_FILE" "$IMG_FILE" "$AUDIO_FILE"; do
  [ -f "$f" ] || { echo "MISSING FIXTURE: $f — see backend/tests/fixtures/e2e/README.md to regenerate"; exit 1; }
done
echo "Fixtures OK."
```

### Pre-flight cleanup (idempotent — safe to re-run)

This nukes any leftovers from a previous crashed run by matching the project name prefix. Run this first, every time.

```bash
# Find any project starting with "E2E Test " and hard-delete it + any content/todos that explicitly belong to it.
# Note: project hard-delete does NOT cascade to content_items (project_ids is array, not FK), so we
# enumerate content/todos in each leftover project and hard-delete them first.

LEFTOVER_PROJECTS=$(curl -s -H "$AUTH" "$API/api/v1/projects" | jq -r '.projects[] | select(.name | startswith("E2E Test ")) | .id')

if [ -n "$LEFTOVER_PROJECTS" ]; then
  echo "Found leftover E2E projects, cleaning up..."
  for pid in $LEFTOVER_PROJECTS; do
    echo "  cleaning project $pid"
    # delete content
    curl -s -H "$AUTH" "$API/api/v1/content?project_id=$pid&include_archived=true" \
      | jq -r '.items[].id' \
      | while read cid; do curl -s -X DELETE -H "$AUTH" "$API/api/v1/content/$cid?hard=true" > /dev/null; done
    # delete todos
    curl -s -H "$AUTH" "$API/api/v1/todos?project_id=$pid&include_archived=true" \
      | jq -r '.todos[].id' \
      | while read tid; do curl -s -X DELETE -H "$AUTH" "$API/api/v1/todos/$tid?hard=true" > /dev/null; done
    # delete project
    curl -s -X DELETE -H "$AUTH" "$API/api/v1/projects/$pid?hard=true" > /dev/null
  done
  echo "Cleanup done."
else
  echo "No leftovers."
fi
```

### Working state — fill these in as you go

```bash
export PROJECT_ID=                # T1.1
export PROJECT_ID_2=              # T1.5
export DOC_ID=                    # T2.1
export NOTE_ID=                   # T2.2
export MULTI_NOTE_ID=             # T2.3
export PDF_DOC_ID=                # T3.1
export IMG_DOC_ID=                # T3.2
export AUDIO_DOC_ID=              # T3.3
export YT_DOC_ID=                 # T4.1
export ARXIV_DOC_ID=              # T4.2
export BLOG_DOC_ID=               # T4.3
export TODO_ID=                   # T5.1
export SUBTASK_ID=                # T5.4
export SUBTASK_ID_2=              # T5.5
export GRANDCHILD_ID=             # T5.7
export COMMENT_ID=                # T6.1
```

---

## Phase 0 — Auth & Health

### T0.1 — Health endpoint (no auth required)
```bash
curl -si "$API/health" | head -5
```
**Pass:** HTTP 200, body `{"ok":true,"service":"devtrail","version":"2.0.0"}`.

[ ] PASS / [ ] FAIL — Notes: ____

### T0.2 — Auth via Bearer header
```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "$AUTH" "$API/api/v1/projects"
```
**Pass:** `200`.

[ ] PASS / [ ] FAIL — Notes: ____

### T0.3 — Query-string keys are refused on REST
```bash
curl -s -o /dev/null -w "%{http_code}\n" "$API/api/v1/projects?key=$KEY"
curl -s -o /dev/null -w "%{http_code}\n" "$API/api/v1/openapi.json"
```
**Pass:** `401` (REST accepts the Bearer header only), then `200` (the OpenAPI spec is public).

[ ] PASS / [ ] FAIL — Notes: ____

### T0.4 — Auth rejection
```bash
curl -s -o /dev/null -w "%{http_code}\n" "$API/api/v1/projects"
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer wrong" "$API/api/v1/projects"
```
**Pass:** Both `401`.

[ ] PASS / [ ] FAIL — Notes: ____

---

## Phase 1 — Projects CRUD

### T1.1 — Create test project (deterministic name with timestamp)
```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
RESP=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/projects" \
  -d "{\"name\":\"E2E Test ${TS}\",\"description\":\"Generated by E2E test plan\"}")
echo "$RESP" | jq .
export PROJECT_ID=$(echo "$RESP" | jq -r .project.id)
echo "PROJECT_ID=$PROJECT_ID"
```
**Pass:** HTTP 201; response shape `{project:{id, name, description, status:"active", created_at, updated_at}}`. PROJECT_ID is a valid UUID. Name starts with `E2E Test `.

[ ] PASS / [ ] FAIL — Notes: ____

### T1.2 — List projects (no filter, status filter)
```bash
curl -s -H "$AUTH" "$API/api/v1/projects" | jq '.projects | map(.id) | index("'"$PROJECT_ID"'")'
curl -s -H "$AUTH" "$API/api/v1/projects?status=active" | jq '.projects | map(.id) | index("'"$PROJECT_ID"'")'
```
**Pass:** Both return non-null index (project found in list).

[ ] PASS / [ ] FAIL — Notes: ____

### T1.3 — Get project by ID
```bash
curl -s -H "$AUTH" "$API/api/v1/projects/$PROJECT_ID" | jq .project
```
**Pass:** Returns same record. Description matches `"Generated by E2E test plan"`.

[ ] PASS / [ ] FAIL — Notes: ____

### T1.4 — Update project (PUT)
```bash
curl -s -X PUT -H "$AUTH" -H "$CT" "$API/api/v1/projects/$PROJECT_ID" \
  -d '{"description":"Updated by T1.4"}' | jq .project.description
curl -s -H "$AUTH" "$API/api/v1/projects/$PROJECT_ID" | jq .project.description
```
**Pass:** Both calls return `"Updated by T1.4"`.

[ ] PASS / [ ] FAIL — Notes: ____

### T1.5 — Create second project
```bash
RESP2=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/projects" \
  -d "{\"name\":\"E2E Test ${TS} (B)\"}")
export PROJECT_ID_2=$(echo "$RESP2" | jq -r .project.id)
echo "PROJECT_ID_2=$PROJECT_ID_2"
```
**Pass:** Different UUID from `$PROJECT_ID`.

[ ] PASS / [ ] FAIL — Notes: ____

### T1.6 — Project bad UUID
```bash
curl -s -H "$AUTH" "$API/api/v1/projects/not-a-uuid" | jq .
```
**Pass:** HTTP 400. Body says `"Invalid UUID format..."`.

[ ] PASS / [ ] FAIL — Notes: ____

---

## Phase 2 — Content items (text-only)

### T2.1 — Create document with named entities
```bash
RESP=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/content" -d '{
  "type":"document",
  "title":"pgvector vs HNSW notes",
  "content":"pgvector is a Postgres extension that adds vector similarity search. It supports several index types including IVFFlat and HNSW. HNSW (Hierarchical Navigable Small World) gives better recall than IVFFlat at the cost of build time and memory. For 3072-dimensional embeddings from Gemini Embedding 2 or OpenAI text-embedding-3-large, HNSW init may exceed memory limits on small Postgres tiers. The Anthropic SDK pairs naturally with these embeddings for downstream RAG synthesis using Claude Haiku 4.5 or Claude Opus 4.7.",
  "project_ids":["'"$PROJECT_ID"'"],
  "tags":["reference","pgvector"]
}')
echo "$RESP" | jq .
export DOC_ID=$(echo "$RESP" | jq -r .id)
echo "DOC_ID=$DOC_ID"
```
**Pass:** HTTP 201; `{id, title, chunkCount}` returned. `chunkCount: 1` (~150 tokens, single chunk). Content references named entities for graph testing.

[ ] PASS / [ ] FAIL — Notes: ____

### T2.2 — Create personal note (no project)
```bash
RESP=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/content" -d '{
  "type":"note",
  "title":"Random idea",
  "content":"Thinking about adding RAG depth visualization to the search UI"
}')
export NOTE_ID=$(echo "$RESP" | jq -r .id)
curl -s -H "$AUTH" "$API/api/v1/content/$NOTE_ID" | jq .item.project_ids
```
**Pass:** Note created. `project_ids` is `[]` (empty array — personal scope).

[ ] PASS / [ ] FAIL — Notes: ____

### T2.3 — Create multi-project note
```bash
RESP=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/content" -d '{
  "type":"note",
  "title":"Cross-project note",
  "content":"This note belongs to both test projects",
  "project_ids":["'"$PROJECT_ID"'","'"$PROJECT_ID_2"'"]
}')
export MULTI_NOTE_ID=$(echo "$RESP" | jq -r .id)
curl -s -H "$AUTH" "$API/api/v1/content/$MULTI_NOTE_ID" | jq '.item.project_ids | length'
```
**Pass:** `project_ids` array length is 2.

[ ] PASS / [ ] FAIL — Notes: ____

### T2.4 — List content with filters
```bash
curl -s -H "$AUTH" "$API/api/v1/content?type=document" | jq '.items | map(.type) | unique'
curl -s -H "$AUTH" "$API/api/v1/content?project_id=$PROJECT_ID" | jq '.items | length'
curl -s -H "$AUTH" "$API/api/v1/content?tags=pgvector" | jq '.items | map(.title)'
```
**Pass:**
- type filter returns only `["document"]`
- `project_id` returns at least 2 items (DOC_ID + MULTI_NOTE_ID)
- tag filter returns items with `"pgvector vs HNSW notes"` in titles
- No `embedding` field in any item

[ ] PASS / [ ] FAIL — Notes: ____

### T2.5 — Get content full record
```bash
curl -s -H "$AUTH" "$API/api/v1/content/$DOC_ID" | jq '{id, title: .item.title, type: .item.type, content_length: (.item.content | length)}'
```
**Pass:** Full record. content_length matches the body text (~605 chars).

[ ] PASS / [ ] FAIL — Notes: ____

### T2.6 — Update content (PUT — tags)
```bash
curl -s -X PUT -H "$AUTH" -H "$CT" "$API/api/v1/content/$DOC_ID" \
  -d '{"tags":["reference","pgvector","updated"]}' | jq .item.tags
curl -s -H "$AUTH" "$API/api/v1/content/$DOC_ID" | jq .item.tags
```
**Pass:** Tags become `["reference","pgvector","updated"]`, persisted.

[ ] PASS / [ ] FAIL — Notes: ____

---

## Phase 3 — File uploads (multimodal)

### T3.1 — Upload PDF (multi-chunk)
```bash
RESP=$(curl -s -X POST -H "$AUTH" "$API/api/v1/content" \
  -F "type=document" \
  -F "title=Sample PDF" \
  -F "project_ids=$PROJECT_ID" \
  -F "file=@$PDF_FILE")
echo "$RESP" | jq .
export PDF_DOC_ID=$(echo "$RESP" | jq -r .id)
curl -s -H "$AUTH" "$API/api/v1/content/$PDF_DOC_ID" | jq '{blob_url: .item.blob_url, mime_type: .item.mime_type, file_hash: .item.file_hash}'
```
**Pass:**
- HTTP 201
- `chunkCount >= 2` (sample.pdf is ~3 pages of pgvector/HNSW prose)
- `blob_url` is a non-null Azure Blob URL
- `mime_type: "application/pdf"`
- `file_hash` is a 64-char SHA-256

[ ] PASS / [ ] FAIL — Notes: ____

### T3.2 — Upload image (OCR)
```bash
RESP=$(curl -s -X POST -H "$AUTH" "$API/api/v1/content" \
  -F "type=document" \
  -F "title=Sample Image" \
  -F "project_ids=$PROJECT_ID" \
  -F "file=@$IMG_FILE")
echo "$RESP" | jq .
export IMG_DOC_ID=$(echo "$RESP" | jq -r .id)
curl -s -H "$AUTH" "$API/api/v1/content/$IMG_DOC_ID" | jq '{title: .item.title, content_preview: (.item.content // "" | .[0:300])}'
```
**Pass:**
- Document created
- `content` contains `"pgvector"`, `"HNSW"`, `"IVFFlat"`, `"Anthropic"`, `"DevTrail"` (OCR'd from sample.png)
- `mime_type` starts with `image/`

[ ] PASS / [ ] FAIL — Notes: ____

### T3.3 — Upload audio (transcription)
```bash
RESP=$(curl -s -X POST -H "$AUTH" "$API/api/v1/content" \
  -F "type=document" \
  -F "title=Sample Audio" \
  -F "project_ids=$PROJECT_ID" \
  -F "file=@$AUDIO_FILE")
echo "$RESP" | jq .
export AUDIO_DOC_ID=$(echo "$RESP" | jq -r .id)
curl -s -H "$AUTH" "$API/api/v1/content/$AUDIO_DOC_ID" | jq '{title: .item.title, content_preview: (.item.content // "" | .[0:300])}'
```
**Pass:**
- Document created
- `content` includes "test recording", "DevTrail", and "pgvector" (loose match — Haiku transcription has minor variance)
- `mime_type` starts with `audio/`

[ ] PASS / [ ] FAIL — Notes: ____

### T3.4 — File hash dedup
```bash
RESP=$(curl -s -X POST -H "$AUTH" "$API/api/v1/content" \
  -F "type=document" \
  -F "title=Dedup Attempt" \
  -F "file=@$PDF_FILE")
echo "$RESP" | jq .
echo "Existing PDF_DOC_ID=$PDF_DOC_ID"
```
**Pass:**
- Response `id == $PDF_DOC_ID`
- `chunkCount: 0` (no new chunks)
- `warnings` mentions duplicate file

[ ] PASS / [ ] FAIL — Notes: ____

### T3.5 — Blob URL is downloadable
```bash
BLOB_URL=$(curl -s -H "$AUTH" "$API/api/v1/content/$PDF_DOC_ID" | jq -r '.item.blob_url')
echo "$BLOB_URL"
curl -s -o /tmp/blob-download.bin -w "Status: %{http_code} Size: %{size_download}\n" "$BLOB_URL"
file /tmp/blob-download.bin
```
**Pass:** HTTP 200, downloaded bytes match the original; `file` reports `PDF document, version ...`.

[ ] PASS / [ ] FAIL — Notes: ____

---

## Phase 4 — URL ingestion

### T4.1 — Ingest YouTube
```bash
RESP=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/content/from-url" \
  -d "{\"url\":\"$YT_URL\",\"project_ids\":[\"$PROJECT_ID\"]}")
echo "$RESP" | jq .
export YT_DOC_ID=$(echo "$RESP" | jq -r .id)
curl -s -H "$AUTH" "$API/api/v1/content/$YT_DOC_ID" | jq '{title: .item.title, source_url: .item.source_url, content_preview: (.item.content[0:200])}'
```
**Pass:**
- Document created with `source_url == $YT_URL`
- `url_type: "youtube"`
- Content contains transcript text — for the Tim Urban TED talk, look for "procrastinator" / "deadlines"
- `title` is reasonable (e.g. "Inside the mind of a master procrastinator" or close)

[ ] PASS / [ ] FAIL — Notes: ____

### T4.2 — Ingest arXiv (HTML, with `published_at`)
```bash
RESP=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/content/from-url" \
  -d "{\"url\":\"$ARXIV_URL\",\"project_ids\":[\"$PROJECT_ID\"],\"tags\":[\"paper\"]}")
echo "$RESP" | jq .
export ARXIV_DOC_ID=$(echo "$RESP" | jq -r .id)
curl -s -H "$AUTH" "$API/api/v1/content/$ARXIV_DOC_ID" | jq '{published_at: .item.published_at, title: .item.title, source_url: .item.source_url}'
```
**Pass:**
- Document created
- `published_at` is `"2017-06-12"` or similar ISO-8601 (arXiv:1706.03762 was June 2017)
- `title` is "Attention Is All You Need" (or close)

[ ] PASS / [ ] FAIL — Notes: ____

### T4.3 — Ingest stable blog post (HTML)
```bash
RESP=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/content/from-url" \
  -d "{\"url\":\"$BLOG_URL\",\"project_ids\":[\"$PROJECT_ID\"]}")
echo "$RESP" | jq .
export BLOG_DOC_ID=$(echo "$RESP" | jq -r .id)
```
**Pass:** `url_type: "html"`, content > 1000 chars, no error. Title contains "Wealth" or "Make Wealth".

[ ] PASS / [ ] FAIL — Notes: ____

### T4.4 — URL dedup
```bash
RESP=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/content/from-url" \
  -d "{\"url\":\"$YT_URL\"}")
echo "$RESP" | jq .
echo "Existing YT_DOC_ID=$YT_DOC_ID"
```
**Pass:** `id == $YT_DOC_ID`, `deduped: true`. HTTP 200 (not 201).

[ ] PASS / [ ] FAIL — Notes: ____

### T4.5 — Bad URL
```bash
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/content/from-url" \
  -d '{"url":"https://this-domain-does-not-exist-9999.example.com/foo"}' | jq .
```
**Pass:** HTTP 400 with descriptive error. No content_item created.

[ ] PASS / [ ] FAIL — Notes: ____

---

## Phase 5 — Todos CRUD + subtasks

### T5.1 — Create root todo
```bash
TOMORROW=$(date -u -v+1d +"%Y-%m-%dT12:00:00Z" 2>/dev/null || date -u -d "tomorrow" +"%Y-%m-%dT12:00:00Z")
RESP=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/todos" -d "{
  \"content\":\"E2E parent task\",
  \"project_id\":\"$PROJECT_ID\",
  \"priority\":\"P2\",
  \"due_date\":\"$TOMORROW\",
  \"tags\":[\"e2e\"]
}")
echo "$RESP" | jq .
export TODO_ID=$(echo "$RESP" | jq -r .id)
```
**Pass:** HTTP 201; status defaults to `not_started`; priority/due_date round-trip.

[ ] PASS / [ ] FAIL — Notes: ____

### T5.2 — List todos with filters
```bash
curl -s -H "$AUTH" "$API/api/v1/todos?project_id=$PROJECT_ID" | jq '.todos | length'
curl -s -H "$AUTH" "$API/api/v1/todos?status=not_started" | jq '.todos | map(.id) | index("'"$TODO_ID"'")'
curl -s -H "$AUTH" "$API/api/v1/todos?priority=P2" | jq '.todos | map(.id) | index("'"$TODO_ID"'")'
```
**Pass:** All three find the todo (length >= 1, indices non-null).

[ ] PASS / [ ] FAIL — Notes: ____

### T5.3 — Update todo (PUT — multiple fields)
```bash
curl -s -X PUT -H "$AUTH" -H "$CT" "$API/api/v1/todos/$TODO_ID" \
  -d '{"status":"in_progress","priority":"P1","content":"E2E parent task (updated)"}' | jq .todo
curl -s -H "$AUTH" "$API/api/v1/todos/$TODO_ID" | jq '{content: .todo.content, status: .todo.status, priority: .todo.priority}'
```
**Pass:** All three fields updated and persisted.

[ ] PASS / [ ] FAIL — Notes: ____

### T5.4 — Create subtask
```bash
RESP=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/todos" -d "{
  \"content\":\"E2E child subtask\",
  \"parent_id\":\"$TODO_ID\",
  \"project_id\":\"$PROJECT_ID\",
  \"priority\":\"P3\"
}")
echo "$RESP" | jq .
export SUBTASK_ID=$(echo "$RESP" | jq -r .id)
curl -s -H "$AUTH" "$API/api/v1/todos/$SUBTASK_ID" | jq '{parent_id: .todo.parent_id, project_id: .todo.project_id}'
```
**Pass:** `parent_id == $TODO_ID`, `project_id == $PROJECT_ID`.

[ ] PASS / [ ] FAIL — Notes: ____

### T5.5 — Create second subtask (for cascade)
```bash
RESP=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/todos" -d "{
  \"content\":\"E2E sibling subtask for cascade\",
  \"parent_id\":\"$TODO_ID\",
  \"project_id\":\"$PROJECT_ID\"
}")
export SUBTASK_ID_2=$(echo "$RESP" | jq -r .id)
echo "SUBTASK_ID_2=$SUBTASK_ID_2"
```
**Pass:** Second subtask created.

[ ] PASS / [ ] FAIL — Notes: ____

### T5.6 — Subtask searchable
```bash
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/search" -d '{
  "query":"sibling subtask cascade",
  "entity_types":["todo"],
  "limit":5
}' | jq '.hits | map({type, id: (.todo.id // .chunk.id), content: (.todo.content // (.chunk.content[0:80]))})'
```
**Pass:** Hit list contains `$SUBTASK_ID_2`. Subtask was embedded and indexed.

[ ] PASS / [ ] FAIL — Notes: ____

### T5.7 — Nested subtask (depth 2)
```bash
RESP=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/todos" -d "{
  \"content\":\"E2E grandchild for nested cascade\",
  \"parent_id\":\"$SUBTASK_ID\"
}")
export GRANDCHILD_ID=$(echo "$RESP" | jq -r .id)
curl -s -H "$AUTH" "$API/api/v1/todos/$GRANDCHILD_ID" | jq .todo.parent_id
```
**Pass:** `parent_id == $SUBTASK_ID`.

[ ] PASS / [ ] FAIL — Notes: ____

### T5.8 — Soft delete + restore
```bash
curl -s -X DELETE -H "$AUTH" "$API/api/v1/todos/$SUBTASK_ID_2" | jq .
curl -s -H "$AUTH" "$API/api/v1/todos?project_id=$PROJECT_ID" | jq '.todos | map(.id) | contains(["'"$SUBTASK_ID_2"'"])'
curl -s -H "$AUTH" "$API/api/v1/todos?project_id=$PROJECT_ID&include_archived=true" | jq '.todos | map(.id) | contains(["'"$SUBTASK_ID_2"'"])'
curl -s -X POST -H "$AUTH" "$API/api/v1/todos/$SUBTASK_ID_2/restore" | jq .
curl -s -H "$AUTH" "$API/api/v1/todos/$SUBTASK_ID_2" | jq .todo.archived
```
**Pass:**
- After soft-delete: not in default list (`false`), in include_archived list (`true`)
- After restore: `archived: false`

[ ] PASS / [ ] FAIL — Notes: ____

### T5.9 — Hard delete subtask (no parent impact)
```bash
curl -s -X DELETE -H "$AUTH" "$API/api/v1/todos/$SUBTASK_ID_2?hard=true" | jq .
echo -n "subtask 2: "; curl -s -o /dev/null -w "%{http_code}\n" -H "$AUTH" "$API/api/v1/todos/$SUBTASK_ID_2"
echo -n "parent: ";    curl -s -o /dev/null -w "%{http_code}\n" -H "$AUTH" "$API/api/v1/todos/$TODO_ID"
echo -n "subtask 1: "; curl -s -o /dev/null -w "%{http_code}\n" -H "$AUTH" "$API/api/v1/todos/$SUBTASK_ID"
echo -n "grandchild: ";curl -s -o /dev/null -w "%{http_code}\n" -H "$AUTH" "$API/api/v1/todos/$GRANDCHILD_ID"
```
**Pass:** Subtask 2 → 404; parent + subtask 1 + grandchild → 200.

[ ] PASS / [ ] FAIL — Notes: ____

---

## Phase 6 — Todo comments CRUD

### T6.1 — Create comment
```bash
RESP=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/todos/$TODO_ID/comments" \
  -d '{"content":"E2E test comment"}')
echo "$RESP" | jq .
export COMMENT_ID=$(echo "$RESP" | jq -r .id)
```
**Pass:** Comment created.

[ ] PASS / [ ] FAIL — Notes: ____

### T6.2 — List comments
```bash
curl -s -H "$AUTH" "$API/api/v1/todos/$TODO_ID/comments" | jq .comments
```
**Pass:** Array contains the comment with content `"E2E test comment"`.

[ ] PASS / [ ] FAIL — Notes: ____

### T6.3 — Update comment
```bash
curl -s -X PUT -H "$AUTH" -H "$CT" "$API/api/v1/todos/$TODO_ID/comments/$COMMENT_ID" \
  -d '{"content":"E2E test comment (edited)"}' | jq .
curl -s -H "$AUTH" "$API/api/v1/todos/$TODO_ID/comments" | jq -r '.comments[0].content'
```
**Pass:** Latest content reads `"E2E test comment (edited)"`.

[ ] PASS / [ ] FAIL — Notes: ____

### T6.4 — Delete one comment, leave another
```bash
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/todos/$TODO_ID/comments" \
  -d '{"content":"Second comment to keep"}' > /dev/null
curl -s -X DELETE -H "$AUTH" "$API/api/v1/todos/$TODO_ID/comments/$COMMENT_ID" | jq .
curl -s -H "$AUTH" "$API/api/v1/todos/$TODO_ID/comments" | jq '.comments | length'
```
**Pass:** Length is 1.

[ ] PASS / [ ] FAIL — Notes: ____

---

## Phase 7 — Search, find_mentions, RAG

### T7.1 — Vector + graph search
```bash
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/search" -d '{
  "query":"vector indexing in postgres",
  "project_id":"'"$PROJECT_ID"'",
  "limit":5,
  "graph":true
}' | jq '.hits | map({similarity, retrieval_path, title: (.chunk.parent_title // .todo.content)})'
```
**Pass:**
- ≥1 hit
- At least one hit's `retrieval_path` contains `{step: "entity", ...}`
- DOC_ID's content (pgvector + HNSW + IVFFlat) ranks among the top hits

[ ] PASS / [ ] FAIL — Notes: ____

### T7.2 — Vector-only search
```bash
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/search" -d '{
  "query":"vector indexing in postgres",
  "project_id":"'"$PROJECT_ID"'",
  "limit":5,
  "graph":false
}' | jq '.hits | map(.retrieval_path | map(.step) | unique)'
```
**Pass:** Every hit's path contains only `["vector"]`. No `entity` steps.

[ ] PASS / [ ] FAIL — Notes: ____

### T7.3 — Tag filter
```bash
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/search" -d '{
  "query":"index",
  "tags":["pgvector"],
  "limit":5
}' | jq '.hits | length'
```
**Pass:** Returns hits limited to tagged content.

[ ] PASS / [ ] FAIL — Notes: ____

### T7.4 — entity_types filter
```bash
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/search" -d '{
  "query":"E2E",
  "entity_types":["todo"],
  "limit":10
}' | jq '.hits | map(.type) | unique'
```
**Pass:** All hits are `type: "todo"`.

[ ] PASS / [ ] FAIL — Notes: ____

### T7.5 — find_mentions: known entity
```bash
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/find-mentions" -d '{
  "entity":"pgvector",
  "limit":10
}' | jq '{canonical: .entity.canonical_name, alias_count: (.entity.aliases | length), mention_count: (.mentions | length)}'
```
**Pass:**
- `canonical` resolves to `pgvector` (case-insensitive match against canonical or alias)
- `mention_count >= 2` (DOC_ID + PDF/IMG/AUDIO content references it)

[ ] PASS / [ ] FAIL — Notes: ____

### T7.6 — find_mentions: alias / case variant
```bash
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/find-mentions" -d '{
  "entity":"PGVector"
}' | jq .entity.canonical_name
```
**Pass:** Resolves to the same entity as T7.5 (alias match works case-insensitively).

[ ] PASS / [ ] FAIL — Notes: ____

### T7.7 — find_mentions: nonexistent
```bash
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/find-mentions" -d '{
  "entity":"asdfqwerty12345"
}' | jq .
```
**Pass:** `{entity: null, mentions: []}`. No error.

[ ] PASS / [ ] FAIL — Notes: ____

### T7.8 — RAG fast
```bash
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/rag" -d '{
  "question":"What does my note say about pgvector?",
  "project_id":"'"$PROJECT_ID"'",
  "depth":"fast"
}' | jq '{depth_used: .meta.depth_used, classify_ms: .meta.timings_ms.classify, total_ms: .meta.timings_ms.total, citations: (.citations | length), answer_preview: .answer[0:300]}'
```
**Pass:**
- `depth_used: "fast"`, `classify_ms: 0`
- `citations` ≥ 1, includes `source_url` for URL-ingested entries
- Answer mentions pgvector / HNSW / IVFFlat with `[1]`-style citations
- Total < 15s

[ ] PASS / [ ] FAIL — Notes: ____

### T7.9 — RAG thorough
```bash
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/rag" -d '{
  "question":"Compare HNSW and IVFFlat tradeoffs based on what I have saved.",
  "project_id":"'"$PROJECT_ID"'",
  "depth":"thorough"
}' | jq '{depth_used, total_ms: .meta.timings_ms.total, answer_preview: .answer[0:400]}'
```
**Pass:** `depth_used: "thorough"`. Comparative answer (not single-fact). Tolerate up to ~90s.

[ ] PASS / [ ] FAIL — Notes: ____

### T7.10 — RAG auto-depth
```bash
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/rag" -d '{
  "question":"What is pgvector?",
  "project_id":"'"$PROJECT_ID"'",
  "depth":"auto"
}' | jq '{depth_used, depth_reason: .meta.depth_reason, classify_ms: .meta.timings_ms.classify}'
```
**Pass:** `depth_used: "fast"` for a definitional query. `classify_ms > 0`.

[ ] PASS / [ ] FAIL — Notes: ____

---

## Phase 8 — MCP wire surface

Each MCP tool is exercised through equivalent REST calls above; this phase confirms the JSON-RPC over `/mcp` works for each tool.

### T8.1 — `list_projects`
```bash
curl -s -X POST "$API/mcp" -H "$AUTH" -H "$CT" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}' \
  | jq -r '.result.content[0].text' | jq 'map(select(.id == "'"$PROJECT_ID"'")) | length'
```
**Pass:** `1`.

[ ] PASS / [ ] FAIL — Notes: ____

### T8.2 — `create` (quick_note)
```bash
curl -s -X POST "$API/mcp" -H "$AUTH" -H "$CT" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create","arguments":{"type":"quick_note","content":"E2E quick note from MCP","project_ids":["'"$PROJECT_ID"'"]}}}' \
  | jq -r '.result.content[0].text' | jq '{id, type, title}'
```
**Pass:** `type: "note"` (quick_note maps to note). AI-generated `title`.

[ ] PASS / [ ] FAIL — Notes: ____

### T8.3 — `list`
```bash
curl -s -X POST "$API/mcp" -H "$AUTH" -H "$CT" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list","arguments":{"entity_type":"document","project_id":"'"$PROJECT_ID"'"}}}' \
  | jq -r '.result.content[0].text' | jq length
```
**Pass:** Count >= 5 (DOC_ID + PDF + IMG + AUDIO + URL-ingested).

[ ] PASS / [ ] FAIL — Notes: ____

### T8.4 — `get`
```bash
curl -s -X POST "$API/mcp" -H "$AUTH" -H "$CT" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get","arguments":{"id":"'"$DOC_ID"'"}}}' \
  | jq -r '.result.content[0].text' | jq .title
```
**Pass:** `"pgvector vs HNSW notes"`.

[ ] PASS / [ ] FAIL — Notes: ____

### T8.5 — `search` with graph
```bash
curl -s -X POST "$API/mcp" -H "$AUTH" -H "$CT" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"search","arguments":{"query":"pgvector","project_id":"'"$PROJECT_ID"'","limit":3}}}' \
  | jq -r '.result.content[0].text' | jq 'map(.retrieval_path | length)'
```
**Pass:** Each hit has non-empty `retrieval_path`.

[ ] PASS / [ ] FAIL — Notes: ____

### T8.6 — `find_mentions`
```bash
curl -s -X POST "$API/mcp" -H "$AUTH" -H "$CT" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"find_mentions","arguments":{"entity":"pgvector","limit":5}}}' \
  | jq -r '.result.content[0].text' | jq '{name: .entity.canonical_name, n: (.mentions | length)}'
```
**Pass:** Resolved with mentions.

[ ] PASS / [ ] FAIL — Notes: ____

### T8.7 — `save_from_url` (dedup)
```bash
curl -s -X POST "$API/mcp" -H "$AUTH" -H "$CT" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"save_from_url","arguments":{"url":"'"$YT_URL"'"}}}' \
  | jq -r '.result.content[0].text' | jq '{id, deduped}'
```
**Pass:** `id == $YT_DOC_ID`, `deduped: true`.

[ ] PASS / [ ] FAIL — Notes: ____

### T8.8 — `get` with bad UUID
```bash
curl -s -X POST "$API/mcp" -H "$AUTH" -H "$CT" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"get","arguments":{"id":"not-a-uuid"}}}' \
  | jq '.result | {isError, text: .content[0].text}'
```
**Pass:** `isError: true`, message includes `"Invalid UUID format"`.

[ ] PASS / [ ] FAIL — Notes: ____

---

## Phase 9 — Cascade behavior

### T9.1 — Hard-delete parent todo cascades to all descendants
```bash
curl -s -X DELETE -H "$AUTH" "$API/api/v1/todos/$TODO_ID?hard=true" | jq .
for id in "$TODO_ID" "$SUBTASK_ID" "$GRANDCHILD_ID"; do
  echo -n "$id: "; curl -s -o /dev/null -w "%{http_code}\n" -H "$AUTH" "$API/api/v1/todos/$id"
done
```
**Pass:** All three return 404 (FK `parent_id ON DELETE CASCADE` propagates 2 levels deep).

[ ] PASS / [ ] FAIL — Notes: ____

### T9.2 — Comments cascade with parent todo
```bash
curl -s -H "$AUTH" "$API/api/v1/todos/$TODO_ID/comments" | jq .comments
```
**Pass:** `comments: []` (the second comment created in T6.4 was cascade-deleted with the parent).

[ ] PASS / [ ] FAIL — Notes: ____

### T9.3 — Hard-delete content item cascades to chunks
```bash
curl -s -X DELETE -H "$AUTH" "$API/api/v1/content/$ARXIV_DOC_ID?hard=true" | jq .
echo -n "doc gone: "; curl -s -o /dev/null -w "%{http_code}\n" -H "$AUTH" "$API/api/v1/content/$ARXIV_DOC_ID"
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/search" -d '{"query":"attention is all you need","limit":10}' \
  | jq '.hits | map(select(.chunk.content_item_id == "'"$ARXIV_DOC_ID"'")) | length'
```
**Pass:** Doc 404. No search hits reference the deleted content_item_id (chunks cascade-deleted via FK; chunk_entities also cascade).

[ ] PASS / [ ] FAIL — Notes: ____

### T9.4 — Project hard-delete does NOT cascade content_items (but scrubs UUID from arrays)
```bash
curl -s -H "$AUTH" "$API/api/v1/content?project_id=$PROJECT_ID" | jq '.items | length'
curl -s -X DELETE -H "$AUTH" "$API/api/v1/projects/$PROJECT_ID?hard=true" | jq .
curl -s -H "$AUTH" "$API/api/v1/content/$DOC_ID" | jq .item.project_ids
```
**Pass:** Content items still exist (no cascade — `project_ids` is `uuid[]`, not an FK), AND the deleted project's UUID has been scrubbed from `project_ids` (`src/db/projects.ts` does `array_remove(project_ids, $1::uuid)` in the same transaction as the delete). For a doc that only belonged to `$PROJECT_ID`, expect `project_ids: []`.

[ ] PASS / [ ] FAIL — Notes: ____

### T9.5 — Project hard-delete sets todo.project_id to NULL
```bash
RESP=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/projects" -d "{\"name\":\"E2E Test ${TS} cascade\"}")
TMP_PROJ=$(echo "$RESP" | jq -r .project.id)
RESP=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/todos" -d "{\"content\":\"todo for cascade\",\"project_id\":\"$TMP_PROJ\"}")
TMP_TODO=$(echo "$RESP" | jq -r .id)
curl -s -X DELETE -H "$AUTH" "$API/api/v1/projects/$TMP_PROJ?hard=true" | jq .
curl -s -H "$AUTH" "$API/api/v1/todos/$TMP_TODO" | jq .todo.project_id
curl -s -X DELETE -H "$AUTH" "$API/api/v1/todos/$TMP_TODO?hard=true" > /dev/null
```
**Pass:** Todo's `project_id` is `null` (FK rule `ON DELETE SET NULL`).

[ ] PASS / [ ] FAIL — Notes: ____

---

## Phase 10 — Cleanup

The pre-flight at the top of this doc is the same as the cleanup. Re-run that block to ensure the system is back to a clean baseline.

### T10.1 — Run cleanup
```bash
LEFTOVER_PROJECTS=$(curl -s -H "$AUTH" "$API/api/v1/projects" | jq -r '.projects[] | select(.name | startswith("E2E Test ")) | .id')

for pid in $LEFTOVER_PROJECTS; do
  echo "cleaning $pid"
  curl -s -H "$AUTH" "$API/api/v1/content?project_id=$pid&include_archived=true" \
    | jq -r '.items[].id' \
    | while read cid; do curl -s -X DELETE -H "$AUTH" "$API/api/v1/content/$cid?hard=true" > /dev/null; done
  curl -s -H "$AUTH" "$API/api/v1/todos?project_id=$pid&include_archived=true" \
    | jq -r '.todos[].id' \
    | while read tid; do curl -s -X DELETE -H "$AUTH" "$API/api/v1/todos/$tid?hard=true" > /dev/null; done
  curl -s -X DELETE -H "$AUTH" "$API/api/v1/projects/$pid?hard=true" > /dev/null
done

# Also clean up orphaned content (created in deleted PROJECT_ID via T9.4) — match by known IDs
for id in "$DOC_ID" "$NOTE_ID" "$MULTI_NOTE_ID" "$PDF_DOC_ID" "$IMG_DOC_ID" "$AUDIO_DOC_ID" "$YT_DOC_ID" "$BLOG_DOC_ID"; do
  [ -n "$id" ] && curl -s -X DELETE -H "$AUTH" "$API/api/v1/content/$id?hard=true" > /dev/null
done
echo "Cleanup done."
```
**Pass:** No errors.

[ ] PASS / [ ] FAIL — Notes: ____

### T10.2 — Final sanity check
```bash
# No projects with the E2E prefix
curl -s -H "$AUTH" "$API/api/v1/projects" | jq '.projects | map(select(.name | startswith("E2E Test "))) | length'
# Known IDs all gone
for id in "$DOC_ID" "$NOTE_ID" "$PDF_DOC_ID" "$IMG_DOC_ID" "$AUDIO_DOC_ID" "$YT_DOC_ID" "$BLOG_DOC_ID"; do
  [ -n "$id" ] && echo -n "$id: " && curl -s -o /dev/null -w "%{http_code}\n" -H "$AUTH" "$API/api/v1/content/$id"
done
```
**Pass:** `0` projects matching prefix; all known IDs return 404.

[ ] PASS / [ ] FAIL — Notes: ____

---

## Baseline expected outcomes

These are the deterministic outputs anyone running the plan should see. Any divergence is signal — investigate before re-running.

### Counts after Phase 5

| Entity | Count in `$PROJECT_ID` | Count in `$PROJECT_ID_2` | Personal scope |
|--------|------------------------|--------------------------|----------------|
| Projects | n/a | n/a | 2 (PROJECT_ID + PROJECT_ID_2) |
| Documents | 7 (text doc + PDF + IMG + AUDIO + YT + arXiv + blog) | 0 | 0 |
| Notes | 1 (multi-project note) | 1 (multi-project note, same record, different project_ids) | 1 (NOTE_ID) |
| Todos (root) | 1 (TODO_ID) | 0 | 0 |
| Subtasks | 2 (SUBTASK_ID + SUBTASK_ID_2) | 0 | 0 |
| Grandchildren | 1 (GRANDCHILD_ID under SUBTASK_ID) | 0 | 0 |

### Specific outputs

- **T2.1** `chunkCount: 1` — the inline content is ~605 chars, ~150 tokens, single chunk.
- **T3.1** `chunkCount`: 2-4 — sample.pdf is multi-page; the chunker should produce 2-4 chunks at 500-token target.
- **T3.2** `content` should include OCR'd text mentioning `pgvector`, `HNSW`, `IVFFlat`, `Anthropic`, `DevTrail`. Haiku's exact phrasing varies but those literal strings should appear.
- **T3.3** `content` should be a transcript of "This is a test recording for DevTrail. The topic is pgvector and Anthropic Haiku."
- **T4.2** `published_at` for arXiv 1706.03762 should be `2017-06-12` (or similar valid ISO-8601 date in June 2017).
- **T4.4** `deduped: true` and HTTP 200 (not 201) on re-ingest.
- **T7.1** Top hit's title should be "pgvector vs HNSW notes" (T2.1's document) for query "vector indexing in postgres".
- **T7.5** `entity.canonical_name` should be lowercase `pgvector` (Haiku canonicalizes).
- **T7.6** Same canonical entity returned for `"PGVector"` (alias case-insensitive match).
- **T7.7** `{entity: null, mentions: []}` exactly.
- **T7.8** `depth_used: "fast"`, `classify_ms: 0`, citations array non-empty.
- **T7.9** `depth_used: "thorough"`, total_ms typically 20-60s.
- **T7.10** `depth_used: "fast"` for "What is pgvector?" (single-fact lookup).
- **T9.1** All three todos return 404 after parent hard-delete.
- **T9.4** Content items remain after project hard-delete; the deleted project's UUID is scrubbed from each `project_ids` array (a doc that only belonged to `$PROJECT_ID` ends up with `project_ids: []`).
- **T9.5** Todo's `project_id` becomes `null` after project hard-delete.

### Total

- **64 tests** across 11 phases (T0–T10)
- **15-20 minutes** runtime
- **~$0.10** in LLM cost (Haiku metadata + Azure GPT-5.4 RAG)

---

## Coverage matrix

| Feature | REST | MCP | Tested in |
|---------|------|-----|-----------|
| Auth (Bearer / query refused / 401) | ✓ | inherited | T0.2-T0.4 |
| Projects CRUD | ✓ | partial (no PUT/DEL via MCP) | T1.* |
| Project bad UUID | ✓ | ✓ | T1.6, T8.8 |
| Content (text) CRUD | ✓ | partial (no PUT/DEL via MCP) | T2.*, T8.* |
| Content multipart (PDF/Image/Audio) | ✓ | n/a | T3.* |
| File hash dedup | ✓ | n/a | T3.4 |
| Blob retrieval | ✓ direct | n/a | T3.5 |
| URL ingest (YouTube/HTML/PDF/dedup/error) | ✓ | ✓ | T4.*, T8.7 |
| `published_at` extraction | ✓ | inherited | T4.2 |
| Todos CRUD + 3-level subtasks | ✓ | partial (no PUT/DEL/parent via MCP) | T5.* |
| Soft delete + restore | ✓ | n/a | T5.8 |
| Todo comments CRUD | ✓ | n/a | T6.* |
| Search vector + graph | ✓ | ✓ | T7.1, T8.5 |
| Search vector-only | ✓ | inherited | T7.2 |
| Search filters (tag, type, project) | ✓ | inherited | T7.3-T7.4 |
| `find_mentions` + alias + nonexistent | ✓ | ✓ | T7.5-T7.7, T8.6 |
| RAG fast / thorough / auto | ✓ | n/a | T7.8-T7.10 |
| Cascade: todo → subtasks (2 levels) | ✓ | n/a | T9.1 |
| Cascade: todo → comments | ✓ | n/a | T9.2 |
| Cascade: content → chunks + chunk_entities | ✓ | n/a | T9.3 |
| Cascade: project → content (none) | ✓ | n/a | T9.4 |
| Cascade: project → todos (SET NULL) | ✓ | n/a | T9.5 |
| Idempotent cleanup | ✓ | n/a | pre-flight + T10.* |
