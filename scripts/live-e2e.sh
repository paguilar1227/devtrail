#!/usr/bin/env bash
#
# live-e2e.sh — End-to-end tests against the live production API.
#
# Hits real endpoints. Everything is namespaced inside a temp project
# (e2e-{timestamp}) and torn down at the end. Designed to be re-runnable;
# leaves no stable state behind.
#
# Usage:
#   API_KEY=... ./scripts/live-e2e.sh
#   API_KEY=... BASE=https://staging-url ./scripts/live-e2e.sh
#
# Exit code: 0 on all-pass, 1 on any failure. Cleanup runs on EXIT regardless.
#
# Coverage: parity-batch surface (pin/unpin, bulk ops, stats, activity, tags,
# edit-body, replace, reprocess, new todos filters). Not covered: MCP transport
# (thin adapter; service layer is exercised here through REST).

set -uo pipefail

BASE="${BASE:-https://your-app.your-env.region.azurecontainerapps.io}"
API_KEY="${API_KEY:?API_KEY env var is required}"

PASS=0
FAIL=0
FAILURES=()
PROJECT_ID=""
CONTENT_IDS=()
TODO_IDS=()

red()    { printf "\033[0;31m%s\033[0m" "$1"; }
green()  { printf "\033[0;32m%s\033[0m" "$1"; }
yellow() { printf "\033[0;33m%s\033[0m" "$1"; }

req() {
  local method="$1" path="$2" body="${3:-}" ct="${4:-application/json}"
  local args=(-s -w "\n%{http_code}" -X "$method" "$BASE$path"
              -H "Authorization: Bearer $API_KEY")
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: $ct" -d "$body")
  fi
  curl "${args[@]}"
}

assert() {
  local name="$1" got="$2" expected="$3"
  if [ "$got" = "$expected" ]; then
    PASS=$((PASS+1))
    echo "  $(green '✓') $name"
  else
    FAIL=$((FAIL+1))
    FAILURES+=("$name (expected: $expected, got: $got)")
    echo "  $(red '✗') $name (expected: $expected, got: $got)"
  fi
}

assert_ge() {
  local name="$1" got="$2" expected="$3"
  if [ -n "$got" ] && [ "$got" != "null" ] && [ "$got" -ge "$expected" ] 2>/dev/null; then
    PASS=$((PASS+1))
    echo "  $(green '✓') $name (got: $got)"
  else
    FAIL=$((FAIL+1))
    FAILURES+=("$name (expected >= $expected, got: $got)")
    echo "  $(red '✗') $name (expected >= $expected, got: $got)"
  fi
}

split_response() {
  local input="$1"
  STATUS="$(echo "$input" | tail -n1)"
  BODY="$(echo "$input" | sed '$d')"
}

poll_ready() {
  local id="$1" max="${2:-20}" status
  for ((i=0; i<max; i++)); do
    status=$(curl -s "$BASE/api/v1/content/$id/status" \
      -H "Authorization: Bearer $API_KEY" | jq -r '.processing_status')
    if [ "$status" = "ready" ]; then echo "ready"; return 0; fi
    if [ "$status" = "failed" ]; then echo "failed"; return 1; fi
    sleep 2
  done
  echo "timeout"
  return 1
}

phase() { echo ""; echo "$(yellow ">> $1")"; }

cleanup() {
  echo ""
  phase "Cleanup"
  if [ -n "$PROJECT_ID" ]; then
    for id in "${CONTENT_IDS[@]}"; do
      curl -s -X DELETE "$BASE/api/v1/content/$id?hard=true" \
        -H "Authorization: Bearer $API_KEY" > /dev/null
    done
    for id in "${TODO_IDS[@]}"; do
      curl -s -X DELETE "$BASE/api/v1/todos/$id?hard=true" \
        -H "Authorization: Bearer $API_KEY" > /dev/null
    done
    leftover_content=$(curl -s "$BASE/api/v1/content?project_id=$PROJECT_ID" \
      -H "Authorization: Bearer $API_KEY" | jq -r '.items[].id' 2>/dev/null)
    for id in $leftover_content; do
      curl -s -X DELETE "$BASE/api/v1/content/$id?hard=true" \
        -H "Authorization: Bearer $API_KEY" > /dev/null
    done
    leftover_todos=$(curl -s "$BASE/api/v1/todos?project_id=$PROJECT_ID" \
      -H "Authorization: Bearer $API_KEY" | jq -r '.todos[].id' 2>/dev/null)
    for id in $leftover_todos; do
      curl -s -X DELETE "$BASE/api/v1/todos/$id?hard=true" \
        -H "Authorization: Bearer $API_KEY" > /dev/null
    done
    curl -s -X DELETE "$BASE/api/v1/projects/$PROJECT_ID?hard=true" \
      -H "Authorization: Bearer $API_KEY" > /dev/null
    echo "  Deleted project $PROJECT_ID and all owned content/todos"
  fi

  echo ""
  echo "============================================"
  echo "Passed: $(green "$PASS")   Failed: $(red "$FAIL")"
  if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "Failures:"
    for f in "${FAILURES[@]}"; do echo "  - $f"; done
    exit 1
  fi
  exit 0
}
trap cleanup EXIT

# ---------------- Phase 1: Auth + health ----------------

phase "Phase 1: Auth + health"

resp=$(curl -s -w "\n%{http_code}" "$BASE/health")
split_response "$resp"
assert "GET /health (no auth) returns 200" "$STATUS" "200"

resp=$(curl -s -w "\n%{http_code}" "$BASE/api/v1/projects")
split_response "$resp"
assert "GET /api/v1/projects without key returns 401" "$STATUS" "401"

resp=$(req GET "/api/v1/projects")
split_response "$resp"
assert "GET /api/v1/projects with key returns 200" "$STATUS" "200"

# ---------------- Phase 2: Projects + pin/unpin ----------------

phase "Phase 2: Projects + pin/unpin"

ts=$(date +%s)
resp=$(req POST "/api/v1/projects" "{\"name\":\"e2e-$ts\",\"description\":\"e2e test run\"}")
split_response "$resp"
assert "POST /api/v1/projects (create) returns 201" "$STATUS" "201"
PROJECT_ID=$(echo "$BODY" | jq -r '.project.id')
echo "  PROJECT_ID=$PROJECT_ID"

resp=$(req POST "/api/v1/projects/$PROJECT_ID/pin")
split_response "$resp"
assert "POST /projects/:id/pin returns 200" "$STATUS" "200"

resp=$(req GET "/api/v1/projects/$PROJECT_ID")
split_response "$resp"
pinned_at=$(echo "$BODY" | jq -r '.project.pinned_at')
[ "$pinned_at" != "null" ] && [ -n "$pinned_at" ] \
  && assert "GET project after pin shows pinned_at" "set" "set" \
  || assert "GET project after pin shows pinned_at" "null" "set"

resp=$(req GET "/api/v1/projects?pinned=true")
split_response "$resp"
contains=$(echo "$BODY" | jq -r ".projects[] | select(.id == \"$PROJECT_ID\") | .id")
assert "GET /projects?pinned=true contains pinned project" "$contains" "$PROJECT_ID"

resp=$(req POST "/api/v1/projects/$PROJECT_ID/unpin")
split_response "$resp"
assert "POST /projects/:id/unpin returns 200" "$STATUS" "200"

resp=$(req GET "/api/v1/projects/$PROJECT_ID")
split_response "$resp"
pinned_at=$(echo "$BODY" | jq -r '.project.pinned_at')
assert "GET project after unpin shows pinned_at=null" "$pinned_at" "null"

# ---------------- Phase 3: Content text + edit-body + body-edit guard ----------------

phase "Phase 3: Content text + edit-body guard"

resp=$(req POST "/api/v1/content" "{\"type\":\"note\",\"title\":\"Edit body test\",\"content\":\"original body\",\"project_ids\":[\"$PROJECT_ID\"]}")
split_response "$resp"
assert "POST /content (note) returns 202" "$STATUS" "202"
C1=$(echo "$BODY" | jq -r '.id')
CONTENT_IDS+=("$C1")
echo "  C1=$C1"

ready=$(poll_ready "$C1")
assert "C1 reaches ready" "$ready" "ready"

resp=$(req PUT "/api/v1/content/$C1" '{"content":"trying to edit via PUT"}')
split_response "$resp"
assert "PUT /content/:id with content field returns 400 (guard)" "$STATUS" "400"

resp=$(req POST "/api/v1/content/$C1/edit-body" '{"content":"updated body via edit-body"}')
split_response "$resp"
assert "POST /content/:id/edit-body returns 202" "$STATUS" "202"

ready=$(poll_ready "$C1")
assert "C1 reaches ready after edit-body" "$ready" "ready"

resp=$(req GET "/api/v1/content/$C1")
split_response "$resp"
new_body=$(echo "$BODY" | jq -r '.item.content')
assert "edit-body updated content" "$new_body" "updated body via edit-body"

# ---------------- Phase 4: Replace ----------------

phase "Phase 4: Replace flow"

resp=$(req POST "/api/v1/content" "{\"type\":\"note\",\"title\":\"Replace v1\",\"content\":\"v1 content\",\"project_ids\":[\"$PROJECT_ID\"]}")
split_response "$resp"
V1=$(echo "$BODY" | jq -r '.id')
CONTENT_IDS+=("$V1")
ready=$(poll_ready "$V1")
assert "V1 reaches ready" "$ready" "ready"

resp=$(req POST "/api/v1/content/$V1/replace" '{"content":"v2 content"}')
split_response "$resp"
assert "POST /content/:id/replace returns 202" "$STATUS" "202"
V2=$(echo "$BODY" | jq -r '.new_id')
CONTENT_IDS+=("$V2")
echo "  V1=$V1 V2=$V2"

ready=$(poll_ready "$V2")
assert "V2 reaches ready" "$ready" "ready"

resp=$(req GET "/api/v1/content/$V1")
split_response "$resp"
v1_archived=$(echo "$BODY" | jq -r '.item.archived')
v1_replaced_by=$(echo "$BODY" | jq -r '.item.metadata.replaced_by')
assert "V1 is archived after replace" "$v1_archived" "true"
assert "V1.metadata.replaced_by = V2" "$v1_replaced_by" "$V2"

resp=$(req GET "/api/v1/content/$V2")
split_response "$resp"
v2_replaces=$(echo "$BODY" | jq -r '.item.metadata.replaces')
assert "V2.metadata.replaces = V1" "$v2_replaces" "$V1"

# ---------------- Phase 5: Content pin/unpin ----------------

phase "Phase 5: Content pin/unpin"

resp=$(req POST "/api/v1/content/$C1/pin")
split_response "$resp"
assert "POST /content/:id/pin returns 200" "$STATUS" "200"

resp=$(req GET "/api/v1/content?pinned=true&project_id=$PROJECT_ID")
split_response "$resp"
contains=$(echo "$BODY" | jq -r ".items[] | select(.id == \"$C1\") | .id")
assert "GET /content?pinned=true contains pinned id" "$contains" "$C1"

resp=$(req POST "/api/v1/content/$C1/unpin")
split_response "$resp"
assert "POST /content/:id/unpin returns 200" "$STATUS" "200"

# ---------------- Phase 6: Tags ----------------

phase "Phase 6: Tags rename + delete"

unique_tag="e2e-tag-$ts"
resp=$(req POST "/api/v1/content" "{\"type\":\"note\",\"content\":\"tag a\",\"project_ids\":[\"$PROJECT_ID\"],\"tags\":[\"$unique_tag\"]}")
split_response "$resp"
T1=$(echo "$BODY" | jq -r '.id')
CONTENT_IDS+=("$T1")
poll_ready "$T1" > /dev/null

resp=$(req POST "/api/v1/content" "{\"type\":\"note\",\"content\":\"tag b\",\"project_ids\":[\"$PROJECT_ID\"],\"tags\":[\"$unique_tag\"]}")
split_response "$resp"
T2=$(echo "$BODY" | jq -r '.id')
CONTENT_IDS+=("$T2")
poll_ready "$T2" > /dev/null

resp=$(req GET "/api/v1/tags?project_id=$PROJECT_ID")
split_response "$resp"
tag_total=$(echo "$BODY" | jq -r ".tags[] | select(.name == \"$unique_tag\") | .total")
assert_ge "GET /tags shows unique_tag with total >= 2" "$tag_total" "2"

renamed_tag="e2e-tag-renamed-$ts"
resp=$(req PUT "/api/v1/tags/$unique_tag" "{\"to\":\"$renamed_tag\"}")
split_response "$resp"
assert "PUT /tags/:name (rename) returns 200" "$STATUS" "200"

resp=$(req GET "/api/v1/tags?project_id=$PROJECT_ID")
split_response "$resp"
renamed_total=$(echo "$BODY" | jq -r ".tags[] | select(.name == \"$renamed_tag\") | .total")
assert_ge "renamed tag visible in /tags with total >= 2" "$renamed_total" "2"

resp=$(req DELETE "/api/v1/tags/$renamed_tag")
split_response "$resp"
assert "DELETE /tags/:name returns 200" "$STATUS" "200"

resp=$(req GET "/api/v1/tags?project_id=$PROJECT_ID")
split_response "$resp"
gone=$(echo "$BODY" | jq -r ".tags[] | select(.name == \"$renamed_tag\") | .name")
assert "deleted tag is gone from /tags" "$gone" ""

# ---------------- Phase 7: Bulk content ops ----------------

phase "Phase 7: Bulk content ops"

B_IDS=()
for i in 1 2 3; do
  resp=$(req POST "/api/v1/content" "{\"type\":\"note\",\"content\":\"bulk $i\",\"project_ids\":[\"$PROJECT_ID\"]}")
  split_response "$resp"
  id=$(echo "$BODY" | jq -r '.id')
  B_IDS+=("$id")
  CONTENT_IDS+=("$id")
done
for id in "${B_IDS[@]}"; do poll_ready "$id" > /dev/null; done

ids_json=$(printf '%s\n' "${B_IDS[@]}" | jq -R . | jq -sc .)

resp=$(req POST "/api/v1/content/bulk" "{\"action\":\"archive\",\"ids\":$ids_json}")
split_response "$resp"
affected=$(echo "$BODY" | jq -r '.affected')
assert "bulk archive affects 3 ids" "$affected" "3"

resp=$(req POST "/api/v1/content/bulk" "{\"action\":\"restore\",\"ids\":$ids_json}")
split_response "$resp"
affected=$(echo "$BODY" | jq -r '.affected')
assert "bulk restore affects 3 ids" "$affected" "3"

resp=$(req POST "/api/v1/content/bulk" "{\"action\":\"add_tags\",\"ids\":$ids_json,\"tags\":[\"e2e-bulk-$ts\"]}")
split_response "$resp"
affected=$(echo "$BODY" | jq -r '.affected')
assert "bulk add_tags affects 3 ids" "$affected" "3"

resp=$(req GET "/api/v1/content/${B_IDS[0]}")
split_response "$resp"
has_tag=$(echo "$BODY" | jq -r ".item.tags[] | select(. == \"e2e-bulk-$ts\")")
assert "bulk add_tags actually persisted on row" "$has_tag" "e2e-bulk-$ts"

resp=$(req POST "/api/v1/content/bulk" "{\"action\":\"remove_tags\",\"ids\":$ids_json,\"tags\":[\"e2e-bulk-$ts\"]}")
split_response "$resp"
assert "bulk remove_tags returns 200" "$STATUS" "200"

resp=$(req GET "/api/v1/content/${B_IDS[0]}")
split_response "$resp"
gone=$(echo "$BODY" | jq -r ".item.tags[] | select(. == \"e2e-bulk-$ts\")")
assert "bulk remove_tags persisted" "$gone" ""

resp=$(req POST "/api/v1/content/bulk" "{\"action\":\"set_project_ids\",\"ids\":$ids_json,\"project_ids\":[]}")
split_response "$resp"
affected=$(echo "$BODY" | jq -r '.affected')
assert "bulk set_project_ids affects 3 ids" "$affected" "3"

# Re-attach to project so cleanup picks them up
req POST "/api/v1/content/bulk" "{\"action\":\"set_project_ids\",\"ids\":$ids_json,\"project_ids\":[\"$PROJECT_ID\"]}" > /dev/null

# ---------------- Phase 8: Todos ----------------

phase "Phase 8: Todos (filters + pin + bulk)"

resp=$(req POST "/api/v1/todos" "{\"content\":\"parent\",\"project_id\":\"$PROJECT_ID\"}")
split_response "$resp"
assert "POST /todos parent returns 201" "$STATUS" "201"
PARENT=$(echo "$BODY" | jq -r '.id')
TODO_IDS+=("$PARENT")

resp=$(req POST "/api/v1/todos" "{\"content\":\"child 1\",\"project_id\":\"$PROJECT_ID\",\"parent_id\":\"$PARENT\",\"priority\":\"P1\",\"due_date\":\"2026-06-01T00:00:00Z\",\"tags\":[\"e2e-todo-$ts\"]}")
split_response "$resp"
CHILD1=$(echo "$BODY" | jq -r '.id')
TODO_IDS+=("$CHILD1")

resp=$(req POST "/api/v1/todos" "{\"content\":\"child 2\",\"project_id\":\"$PROJECT_ID\",\"parent_id\":\"$PARENT\",\"priority\":\"P3\",\"due_date\":\"2026-12-01T00:00:00Z\",\"tags\":[\"e2e-todo-$ts\"]}")
split_response "$resp"
CHILD2=$(echo "$BODY" | jq -r '.id')
TODO_IDS+=("$CHILD2")

resp=$(req GET "/api/v1/todos?parent_id=$PARENT")
split_response "$resp"
child_count=$(echo "$BODY" | jq -r '.todos | length')
assert "GET /todos?parent_id=PARENT returns 2 children" "$child_count" "2"

resp=$(req GET "/api/v1/todos?tags=e2e-todo-$ts")
split_response "$resp"
tagged=$(echo "$BODY" | jq -r '.todos | length')
assert "GET /todos?tags= filter returns 2" "$tagged" "2"

resp=$(req GET "/api/v1/todos?due_before=2026-09-01T00:00:00Z&parent_id=$PARENT")
split_response "$resp"
due_count=$(echo "$BODY" | jq -r '.todos | length')
assert "GET /todos?due_before= filter narrows correctly" "$due_count" "1"

resp=$(req GET "/api/v1/todos?due_after=2026-09-01T00:00:00Z&parent_id=$PARENT")
split_response "$resp"
due_count=$(echo "$BODY" | jq -r '.todos | length')
assert "GET /todos?due_after= filter narrows correctly" "$due_count" "1"

resp=$(req POST "/api/v1/todos/$PARENT/pin")
split_response "$resp"
assert "POST /todos/:id/pin returns 200" "$STATUS" "200"

resp=$(req GET "/api/v1/todos?pinned=true&project_id=$PROJECT_ID")
split_response "$resp"
contains=$(echo "$BODY" | jq -r ".todos[] | select(.id == \"$PARENT\") | .id")
assert "GET /todos?pinned=true contains pinned parent" "$contains" "$PARENT"

resp=$(req POST "/api/v1/todos/$PARENT/unpin")
split_response "$resp"
assert "POST /todos/:id/unpin returns 200" "$STATUS" "200"

todo_ids_json=$(printf '%s\n' "$CHILD1" "$CHILD2" | jq -R . | jq -sc .)

resp=$(req POST "/api/v1/todos/bulk" "{\"action\":\"set_status\",\"ids\":$todo_ids_json,\"status\":\"done\"}")
split_response "$resp"
affected=$(echo "$BODY" | jq -r '.affected')
assert "bulk set_status affects 2 todos" "$affected" "2"

resp=$(req POST "/api/v1/todos/bulk" "{\"action\":\"set_priority\",\"ids\":$todo_ids_json,\"priority\":\"P2\"}")
split_response "$resp"
affected=$(echo "$BODY" | jq -r '.affected')
assert "bulk set_priority affects 2 todos" "$affected" "2"

resp=$(req POST "/api/v1/todos/bulk" "{\"action\":\"set_due_date\",\"ids\":$todo_ids_json,\"due_date\":\"2026-08-15T00:00:00Z\"}")
split_response "$resp"
affected=$(echo "$BODY" | jq -r '.affected')
assert "bulk set_due_date affects 2 todos" "$affected" "2"

resp=$(req POST "/api/v1/todos/bulk" "{\"action\":\"set_project_id\",\"ids\":$todo_ids_json,\"project_id\":null}")
split_response "$resp"
affected=$(echo "$BODY" | jq -r '.affected')
assert "bulk set_project_id null detaches to Inbox" "$affected" "2"

req POST "/api/v1/todos/bulk" "{\"action\":\"set_project_id\",\"ids\":$todo_ids_json,\"project_id\":\"$PROJECT_ID\"}" > /dev/null

# ---------------- Phase 9: Stats + activity ----------------

phase "Phase 9: Stats + activity"

resp=$(req GET "/api/v1/stats?project_id=$PROJECT_ID")
split_response "$resp"
assert "GET /stats?project_id= returns 200" "$STATUS" "200"
notes_count=$(echo "$BODY" | jq -r '.counts.notes')
assert_ge "/stats reports notes >= 5 in project" "$notes_count" "5"
todos_count=$(echo "$BODY" | jq -r '.counts.todos.total')
assert_ge "/stats reports todos.total >= 3 in project" "$todos_count" "3"

resp=$(req GET "/api/v1/activity?project_id=$PROJECT_ID&limit=50")
split_response "$resp"
assert "GET /activity?project_id= returns 200" "$STATUS" "200"
event_count=$(echo "$BODY" | jq -r '.activity | length')
assert_ge "/activity has events for project" "$event_count" "1"

# ---------------- Phase 10: Reprocess ----------------

phase "Phase 10: Reprocess"

resp=$(req POST "/api/v1/content/$C1/reprocess")
split_response "$resp"
assert "POST /content/:id/reprocess returns 202" "$STATUS" "202"

ready=$(poll_ready "$C1")
assert "C1 returns to ready after reprocess" "$ready" "ready"
