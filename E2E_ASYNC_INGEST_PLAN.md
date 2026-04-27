# Open Brain v2 — Async Ingest E2E Plan

End-to-end validation for the async REST ingest refactor (`processing_status` column + 202-on-accept + polling). Ran interactively, phase by phase. Each phase ends with a pass/fail check; do not move to the next phase until the prior one is green.

**Resource cost** is real on every phase that hits prod (Supadata, Gemini, Anthropic, Azure Blob, Firecrawl). Run each phase deliberately, not in a loop.

---

## Reproducibility

- Pre-deploy production snapshot is captured before Phase 1 and re-checked at Phase 2.
- Pinned URL/file fixtures match the existing `E2E_TEST_PLAN.md` (no re-pinning here — keep one source of truth).
- Tests are sequenced; later phases depend on earlier ones (snapshot → deploy → regression → new contract).

## Prerequisites

```bash
cd ~/src/open-brain-v2
export API="https://your-app.your-env.region.azurecontainerapps.io"
export KEY="$(az keyvault secret show --vault-name your-keyvault --name open-brain-api-key --query value -o tsv)"
export AUTH="Authorization: Bearer $KEY"
export CT="Content-Type: application/json"

# Pinned URL fixtures (mirror E2E_TEST_PLAN.md)
export YT_URL="https://www.youtube.com/watch?v=8jPQjjsBbIc"
export ARXIV_URL="https://arxiv.org/abs/1706.03762"
export BLOG_URL="https://www.paulgraham.com/wealth.html"

# Local file fixtures
export PDF_FILE="$PWD/tests/fixtures/e2e/sample.pdf"
export IMG_FILE="$PWD/tests/fixtures/e2e/sample.png"

# Sanity
curl -s "$API/health" | jq .
```

---

## Pre-flight — Production snapshot (do this **before** the deploy)

Capture every existing content_item id + title so we can prove nothing was lost.

### P.1 — Snapshot existing content
```bash
mkdir -p docs/snapshots
SNAP="docs/snapshots/pre-async-ingest-$(date +%Y%m%d-%H%M%S).json"
curl -s -H "$AUTH" "$API/api/v1/content?include_archived=true&limit=10000" \
  | jq '{
      taken_at: now | todate,
      total: .items | length,
      items: [.items[] | {id, type, title, source_url, archived, project_ids}]
    }' > "$SNAP"
echo "Snapshot: $SNAP"
jq '{total, sample: (.items[:5] | map({id, title, type}))}' "$SNAP"
```
**Pass:** file written, `total` is the count Alex expects, sample looks like real docs (not test artifacts).

### P.2 — Pick 3 known-good docs to retrieval-test later
Pick 3 ids from the snapshot you care most about (real research, not E2E leftovers). Export them:
```bash
export DOC1="<paste id>"   # something with searchable text
export DOC2="<paste id>"   # ideally a different type (note vs document)
export DOC3="<paste id>"   # ideally distinct topic
```
**Pass:** `curl -s -H "$AUTH" "$API/api/v1/content/$DOC1" | jq '{id,title,type}'` returns each.

---

## Phase 0 — Local sanity (no prod cost)

Verify the build is green before we ever touch prod.

### T0.1 — Type-check
```bash
npx tsc --noEmit
```
**Pass:** zero output, exit 0.

### T0.2 — Full test suite
```bash
npm test
```
**Pass:** all tests green (count should be ≥ current 126 + new tests we added for this work).

### T0.3 — Migration unit test exists
```bash
ls tests/unit/db/migrations*.test.ts 2>/dev/null && \
  npx vitest run tests/unit/db/migrations.test.ts
```
**Pass:** the new migration test runs and asserts: pre-migration rows get `processing_status='ready'`; chunks still resolve to parents; count unchanged.

---

## Phase 1 — Deploy and verify migration

Push to main, wait for CI + Deploy, then validate the migration applied cleanly.

### T1.1 — Push
```bash
git push
```
**Pass:** push succeeds.

### T1.2 — Wait for CI + Deploy both green
```bash
SHA=$(git rev-parse --short HEAD)
echo "Polling for $SHA …"
while true; do
  R=$(gh run list --repo paguilar1227/open-brain-v2 --limit 4 --json status,conclusion,name,headSha --jq '.[] | "\(.headSha[0:7]) \(.status) \(.conclusion) \(.name)"')
  CI=$(echo "$R" | grep "^$SHA completed.*CI$" | head -1)
  DP=$(echo "$R" | grep "^$SHA completed.*Deploy" | head -1)
  if [ -n "$CI" ] && [ -n "$DP" ]; then echo "$CI"; echo "$DP"; break; fi
  sleep 10
done
```
**Pass:** both lines say `completed success`.

### T1.3 — Health check post-deploy
```bash
curl -s "$API/health" | jq .
```
**Pass:** `{"ok":true,"service":"open-brain","version":"2.0.0"}`.

### T1.4 — Verify migration applied: every existing row has `processing_status='ready'`
```bash
# Sample: pull 50 rows and confirm processing_status is 'ready' on each
curl -s -H "$AUTH" "$API/api/v1/content?include_archived=true&limit=50" \
  | jq '.items | map(.processing_status) | group_by(.) | map({status: .[0], count: length})'
```
**Pass:** output is `[{"status":"ready","count":50}]` (no nulls, no other states).

### T1.5 — Count unchanged
```bash
SNAP_FILE=$(ls -1t docs/snapshots/pre-async-ingest-*.json | head -1)
PRE=$(jq '.total' "$SNAP_FILE")
POST=$(curl -s -H "$AUTH" "$API/api/v1/content?include_archived=true&limit=10000" | jq '.items | length')
echo "pre=$PRE  post=$POST"
[ "$PRE" = "$POST" ] && echo "MATCH" || echo "MISMATCH — STOP"
```
**Pass:** `MATCH`.

---

## Phase 2 — Existing-content retrieval regression

Confirm that real, important documents are still retrievable. **Stop the moment any one of these fails — do not continue to new-content phases.**

### T2.1 — `get` each of DOC1/DOC2/DOC3
```bash
for d in $DOC1 $DOC2 $DOC3; do
  curl -s -H "$AUTH" "$API/api/v1/content/$d" | jq '{id,title,type,processing_status,chunkCount: (.chunks // [] | length)}'
done
```
**Pass:** all three return real titles, `processing_status='ready'`, and chunkCount matches what was there pre-deploy (snapshot for reference).

### T2.2 — `search` returns each of DOC1/DOC2/DOC3
For each doc, pick a distinctive phrase from its title (or a topic you remember it covered) and confirm it surfaces:
```bash
# example — adapt the query to each doc
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/search" \
  -d '{"query":"<distinctive phrase from DOC1>","limit":10}' \
  | jq '.hits | map({id: .content_item_id, title: .title, score})'
```
**Pass:** the corresponding doc id appears in the top 10 hits for its query.

### T2.3 — RAG against a known doc
Pick one doc you know the contents of and ask a question only that doc can answer:
```bash
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/rag" \
  -d '{"question":"<a question only DOC1 can answer>","depth":"fast"}' \
  | jq '{answer: .answer, citations: (.citations // [] | map({id, title}))}'
```
**Pass:** answer is grounded in DOC1's actual content, and DOC1's id appears in the citations.

### T2.4 — Pending items are filtered (forward-looking — should be no-op now)
```bash
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/search" \
  -d '{"query":"the","limit":50}' \
  | jq '.hits | map(.content_item_id) as $ids
       | "$ids returned: \($ids | length)"'
```
**Pass:** sanity — search still works against the corpus and returns plausible counts.

---

## Phase 3 — New URL ingest async contract

Test project `E2E Async Test` for everything below. Create it once.

### T3.1 — Create scratch project
```bash
PROJ_ID=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/projects" \
  -d '{"name":"E2E Async Test","description":"delete me when done"}' | jq -r '.id')
echo "PROJ_ID=$PROJ_ID"
```
**Pass:** `PROJ_ID` is a uuid.

### T3.2 — POST /from-url returns 202 + pending in <5s
```bash
T0=$(python3 -c 'import time;print(time.time())')
RESP=$(curl -s -w "\n--HTTP-- %{http_code} %{time_total}\n" -X POST -H "$AUTH" -H "$CT" \
  "$API/api/v1/content/from-url" \
  -d "{\"url\":\"$YT_URL?_e2e=$(date +%s)\",\"project_ids\":[\"$PROJ_ID\"]}")
echo "$RESP"
ID=$(echo "$RESP" | sed '/^--HTTP--/d' | jq -r '.id')
echo "ID=$ID"
```
**Pass:** HTTP 202, `time_total` < 5s, response body contains `id` and `processing_status: "pending"`.

### T3.3 — Poll until ready
```bash
for i in $(seq 1 30); do
  STATUS=$(curl -s -H "$AUTH" "$API/api/v1/content/$ID" | jq -r '.processing_status')
  echo "  poll $i: $STATUS"
  [ "$STATUS" = "ready" ] && break
  [ "$STATUS" = "failed" ] && { echo "FAILED — STOP"; exit 1; }
  sleep 1
done
```
**Pass:** status flips to `ready` within ~15s. No `failed`.

### T3.4 — Final shape is correct
```bash
curl -s -H "$AUTH" "$API/api/v1/content/$ID" \
  | jq '{id, title, processing_status, processing_error, type, chunkCount: (.chunks // [] | length), source_url}'
```
**Pass:** title is the real video title (not a placeholder), `chunkCount > 0`, `processing_error` is null.

### T3.5 — Pending row is invisible to search before completion (re-trigger)
```bash
# Kick off another ingest with a unique URL and immediately search before it lands
NEW_URL="$YT_URL?_e2e2=$(date +%s)"
ID2=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/content/from-url" \
  -d "{\"url\":\"$NEW_URL\",\"project_ids\":[\"$PROJ_ID\"]}" | jq -r '.id')
echo "ID2=$ID2"
sleep 1   # give the row time to exist but not finish
# search for the title we know it'll have
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/search" \
  -d '{"query":"procrastinator","project_id":"'"$PROJ_ID"'","limit":10}' \
  | jq '.hits | map({id: .content_item_id, title: .title})'
```
**Pass:** `ID2` is **not** in the hits while it's still pending.

### T3.6 — Once ready, it surfaces
Wait until `ID2` is ready (re-poll), then re-run the search.
```bash
for i in $(seq 1 30); do
  S=$(curl -s -H "$AUTH" "$API/api/v1/content/$ID2" | jq -r '.processing_status')
  [ "$S" = "ready" ] && break; sleep 1
done
curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/search" \
  -d '{"query":"procrastinator","project_id":"'"$PROJ_ID"'","limit":10}' \
  | jq '.hits | map({id: .content_item_id, title: .title})'
```
**Pass:** `ID2` is in the hits.

---

## Phase 4 — File upload async contract

### T4.1 — POST multipart returns 202 + pending in <5s
```bash
T0=$(python3 -c 'import time;print(time.time())')
RESP=$(curl -s -w "\n--HTTP-- %{http_code} %{time_total}\n" -X POST -H "$AUTH" \
  "$API/api/v1/content" \
  -F "file=@$PDF_FILE" \
  -F "project_ids=$PROJ_ID")
echo "$RESP"
PDF_ID=$(echo "$RESP" | sed '/^--HTTP--/d' | jq -r '.id')
echo "PDF_ID=$PDF_ID"
```
**Pass:** HTTP 202, `time_total` < 5s, body has `id` and `processing_status: "pending"`.

### T4.2 — Poll until ready
```bash
for i in $(seq 1 60); do
  S=$(curl -s -H "$AUTH" "$API/api/v1/content/$PDF_ID" | jq -r '.processing_status')
  echo "  poll $i: $S"
  [ "$S" = "ready" ] && break
  [ "$S" = "failed" ] && { echo "FAILED — STOP"; exit 1; }
  sleep 1
done
curl -s -H "$AUTH" "$API/api/v1/content/$PDF_ID" \
  | jq '{title, chunkCount: (.chunks // [] | length), processing_status, processing_error}'
```
**Pass:** ready within ~30s, real title, chunkCount > 0.

---

## Phase 5 — Failure path

### T5.1 — Force a known-bad URL → row lands in `failed`
```bash
BAD_URL="https://www.youtube.com/watch?v=THIS_ID_DOES_NOT_EXIST_ABC123"
RESP=$(curl -s -X POST -H "$AUTH" -H "$CT" "$API/api/v1/content/from-url" \
  -d "{\"url\":\"$BAD_URL\",\"project_ids\":[\"$PROJ_ID\"]}")
echo "$RESP"
BAD_ID=$(echo "$RESP" | jq -r '.id')
# If the URL was rejected before the row was even inserted (4xx), that's also acceptable behavior
# and Phase 5 effectively trivially passes — note which case it is.
echo "BAD_ID=$BAD_ID"
```
**Pass either:** (a) HTTP 4xx (URL rejected synchronously, no row created — fine), OR (b) HTTP 202 with `id` and the polled status eventually flips to `failed` with a non-null `processing_error`.

If (b):
```bash
for i in $(seq 1 30); do
  S=$(curl -s -H "$AUTH" "$API/api/v1/content/$BAD_ID" | jq -r '.processing_status')
  echo "  poll $i: $S"
  [ "$S" = "ready" ] && { echo "UNEXPECTED ready — STOP"; exit 1; }
  [ "$S" = "failed" ] && break
  sleep 2
done
curl -s -H "$AUTH" "$API/api/v1/content/$BAD_ID" \
  | jq '{processing_status, processing_error}'
```
**Pass:** `processing_status: "failed"`, `processing_error` is a clear, human-readable string.

---

## Phase 6 — MCP regression

The MCP contract did not change. Confirm nothing got broken in transit.

### T6.1 — `save_from_url` via MCP still blocks until ready
Run this in a Claude Code/Desktop session connected to the prod MCP:

> Call the Open Brain MCP tool `save_from_url` with the URL `<YT_URL with a fresh ?_mcp=$(date +%s)>` and project `E2E Async Test`. Report the `id`, the `chunkCount`, the wall-clock duration, and the title returned.

**Pass:** the MCP call returns synchronously after the full ingest (~10–15s), reports a real title and chunkCount, no errors. The id it returns must be retrievable via REST and already have `processing_status: 'ready'` when the MCP call completed.

### T6.2 — `create` (note + document with file) via MCP — already-sync paths regression
Run via the MCP:
> Call `create` with `type: "note"`, title "E2E Async Test note", content "this is a sync regression check". Then call `create` with `type: "document"` and the sample PDF.

**Pass:** both return successfully, both items show `processing_status: "ready"` when fetched via REST after the MCP call returns. (Note: text-only notes stay sync regardless; document with file goes through the same async tail but MCP awaits it.)

---

## Phase 7 — Cleanup

```bash
# Delete every content_item in the test project
curl -s -H "$AUTH" "$API/api/v1/content?project_id=$PROJ_ID&include_archived=true" \
  | jq -r '.items[].id' \
  | while read cid; do curl -s -X DELETE -H "$AUTH" "$API/api/v1/content/$cid?hard=true" > /dev/null; done

# Delete the test project
curl -s -X DELETE -H "$AUTH" "$API/api/v1/projects/$PROJ_ID?hard=true" -w "%{http_code}\n"
```
**Pass:** all deletes return 200.

### Final confirm: production count restored to baseline + zero pending leaks
```bash
SNAP_FILE=$(ls -1t docs/snapshots/pre-async-ingest-*.json | head -1)
PRE=$(jq '.total' "$SNAP_FILE")
POST=$(curl -s -H "$AUTH" "$API/api/v1/content?include_archived=true&limit=10000" | jq '.items | length')
PENDING=$(curl -s -H "$AUTH" "$API/api/v1/content?include_archived=true&limit=10000" | jq '[.items[] | select(.processing_status != "ready")] | length')
echo "pre=$PRE  post=$POST  pending=$PENDING"
[ "$PRE" = "$POST" ] && [ "$PENDING" = "0" ] && echo "GREEN" || echo "INVESTIGATE"
```
**Pass:** `GREEN`. Pre-deploy total restored, zero non-ready rows lingering.

---

## Phase exit checklist

- [ ] Pre-flight snapshot captured
- [ ] Phase 0 local sanity green
- [ ] Phase 1 deploy + migration green
- [ ] Phase 2 existing-content retrieval green (DOC1/DOC2/DOC3 all retrieve, search hits, RAG cites correctly)
- [ ] Phase 3 URL ingest async contract green
- [ ] Phase 4 file upload async contract green
- [ ] Phase 5 failure path green
- [ ] Phase 6 MCP regression green
- [ ] Phase 7 cleanup green, count restored, zero pending

If any phase fails, stop. Investigate. Don't continue.
