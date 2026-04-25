#!/usr/bin/env bash
# rag-profile.sh — RAG latency + quality profile across model/effort configs.
#
# Reproducible profile for tracking how model swaps and reasoning_effort
# changes affect RAG performance + answer quality. The output is intended
# to be diffed against prior runs in docs/profiles/.
#
# Prerequisites:
#   1. E2E_TEST_PLAN.md phases 0-4 already run, populating:
#        - A test project with the standard sample.pdf / sample.png /
#          sample.wav uploaded plus the pinned URL-ingested docs (arXiv,
#          blog, YouTube). 7 content items total.
#        - State file at /tmp/e2e-state.sh that exports PROJECT_ID.
#   2. Auth: az login + Key Vault access for the open-brain-api-key secret.
#   3. Backfilled entity edges (POST /api/v1/diagnostics/backfill-entities)
#      so the graph layer is populated.
#
# Usage:
#   bash scripts/rag-profile.sh                    # writes to /tmp/rag-profile/
#   bash scripts/rag-profile.sh /path/to/outdir    # custom outdir
#
# Output:
#   $OUTDIR/results.jsonl           # one JSON line per call (timings, tokens, lengths)
#   $OUTDIR/{Q}_{config}.txt        # the verbatim answer per config × question
#   stdout: per-call summary + final summary table
#
# To add a new config (e.g. once gpt-5.5 quota lands):
#   - Append a line to the CONFIGS array below: "label|depth|effort"
#   - Optionally add a new query if exercising a new failure mode
set -uo pipefail

API="${OPENBRAIN_API:-https://your-app.your-env.region.azurecontainerapps.io}"
KEY="${OPENBRAIN_KEY:-$(az keyvault secret show --vault-name your-keyvault --name open-brain-api-key --query value -o tsv 2>/dev/null)}"
AUTH="Authorization: Bearer $KEY"
CT="Content-Type: application/json"

OUTDIR="${1:-/tmp/rag-profile}"
mkdir -p "$OUTDIR"
RESULTS="$OUTDIR/results.jsonl"
> "$RESULTS"

# Pull PROJECT_ID from the e2e state file (or env override).
if [ -z "${PROJECT_ID:-}" ]; then
  if [ -f /tmp/e2e-state.sh ]; then
    # shellcheck disable=SC1091
    source /tmp/e2e-state.sh
  fi
fi
if [ -z "${PROJECT_ID:-}" ]; then
  echo "PROJECT_ID not set. Either run the E2E plan first to populate /tmp/e2e-state.sh," >&2
  echo "or export PROJECT_ID before running this script." >&2
  exit 1
fi
echo "Profile target: $API"
echo "Project ID:     $PROJECT_ID"
echo "Output dir:     $OUTDIR"

# ------------------------------------------------------------
# Pinned questions — covering the cognitive spectrum.
# Don't edit casually; baseline-comparison loses meaning if the
# inputs drift.
# ------------------------------------------------------------
declare -a QUESTIONS=(
  "What is pgvector?"
  "Compare HNSW and IVFFlat tradeoffs based on what I have saved."
  "Across all my saved material, summarize the embedding-model vs index-type design choices and their tradeoffs."
)
declare -a Q_LABELS=("Q1-define" "Q2-compare" "Q3-multihop")

# ------------------------------------------------------------
# Configs — label | depth | reasoning_effort (empty for fast).
# ------------------------------------------------------------
declare -a CONFIGS=(
  "fast|fast|"
  "thorough.low|thorough|low"
  "thorough.medium|thorough|medium"
  "thorough.high|thorough|high"
)

i=0
total=$((${#QUESTIONS[@]} * ${#CONFIGS[@]}))
for qidx in "${!QUESTIONS[@]}"; do
  q="${QUESTIONS[$qidx]}"
  qlabel="${Q_LABELS[$qidx]}"
  for cfg in "${CONFIGS[@]}"; do
    IFS='|' read -r clabel depth effort <<< "$cfg"
    i=$((i+1))
    echo
    echo "=== [$i/$total] $qlabel / $clabel ==="

    # Build payload (use jq -Rs for the question to handle quotes safely).
    PAYLOAD=$(jq -nc \
      --arg q "$q" \
      --arg pid "$PROJECT_ID" \
      --arg depth "$depth" \
      --arg effort "$effort" \
      '{question: $q, project_id: $pid, depth: $depth} +
        (if $effort != "" then {reasoning_effort: $effort} else {} end)')

    RESP=$(curl -s --max-time 240 -X POST -H "$AUTH" -H "$CT" "$API/api/v1/rag" -d "$PAYLOAD")

    SUMMARY=$(echo "$RESP" | python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read(), strict=False)
except Exception as e:
    print(json.dumps({'question': '$qlabel', 'config': '$clabel', 'error': f'parse: {e}'})); sys.exit(0)
m = d.get('meta', {})
ts = m.get('timings_ms', {})
print(json.dumps({
  'question': '$qlabel',
  'config': '$clabel',
  'depth_used': m.get('depth_used'),
  'classify_ms': ts.get('classify'),
  'embed_ms':    ts.get('embed'),
  'db_scan_ms':  ts.get('db_scan'),
  'graph_ms':    ts.get('graph'),
  'synth_ms':    ts.get('synthesize'),
  'total_ms':    ts.get('total'),
  'answer_len':  len(d.get('answer','')),
  'used_chunks': d.get('used_chunks'),
  'error': d.get('error'),
}))
")
    echo "$SUMMARY"
    echo "$SUMMARY" >> "$RESULTS"

    echo "$RESP" | python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read(), strict=False)
    print(d.get('answer','<no answer>'))
except: print('<parse error>')
" > "$OUTDIR/${qlabel}_${clabel}.txt"

    sleep 1
  done
done

echo
echo "=== Summary ==="
python3 -c "
import json
rows = [json.loads(l) for l in open('$RESULTS')]
print(f'{\"question\":<14} {\"config\":<20} {\"total_s\":>9} {\"synth_s\":>9} {\"ans_len\":>8} {\"chunks\":>7}')
print('-' * 72)
for r in rows:
    if r.get('error'):
        print(f'{r.get(\"question\",\"?\"):<14} {r.get(\"config\",\"?\"):<20} ERROR: {r[\"error\"]}'); continue
    print(f'{r[\"question\"]:<14} {r[\"config\"]:<20} {(r[\"total_ms\"] or 0)/1000:>9.1f} {(r[\"synth_ms\"] or 0)/1000:>9.1f} {r[\"answer_len\"]:>8} {r[\"used_chunks\"]:>7}')
"
