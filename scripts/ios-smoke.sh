#!/usr/bin/env bash
# ios-smoke.sh — native iOS shell smoke test (local-only; needs macOS + Xcode).
#
# Proves the Capacitor shell works END TO END against a live backend:
#   build web bundle → sync → xcodebuild → fresh install (clears stored
#   config) → first-run connect screen (typed URL + API key) → Home →
#   create a todo through the UI → verify the row via the REST API → clean up.
#
# This is the only test layer that exercises the real native context
# (capacitor:// origin, WKWebView fetch/CORS, connect flow, safe areas).
# The CORS-credentials bug (2026-07-30) was only catchable here.
#
# Input simulation is idb HID injection. The WKWebView exposes no per-element
# accessibility tree to idb, so the two interactions that need a location use
# FIXED COORDINATES pinned to DEVICE_NAME's 390x844pt layout. If the connect
# screen or Home composer layout changes materially, update the coords below.
#
# Usage:
#   scripts/ios-smoke.sh                  # full run
#   SKIP_BUILD=1 scripts/ios-smoke.sh     # reuse the last xcodebuild output
#
# Requires: Xcode + iOS simulator runtime, idb (fb-idb under Python 3.12 —
# see .claude/rules/frontend.md), a reachable backend (starts one if absent).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVICE_NAME="${DEVICE_NAME:-iPhone 17e}"
BUNDLE_ID="com.example.openbrain"
SERVER_URL="${SERVER_URL:-http://localhost:3001}"
# Per-invocation artifact dir (screenshots + backend log) so a failing run's
# evidence survives later runs; the 10 newest are kept.
ARTIFACTS="$REPO_ROOT/.ios-smoke/run-$(date +%Y%m%d-%H%M%S)"
APP_PATH="$REPO_ROOT/frontend/ios/App/DerivedData/Build/Products/Debug-iphonesimulator/App.app"

# Home composer row ("+ New todo — press Enter to add"). The connect screen
# needs no coordinates: the server field autofocuses and hardware Tab (HID 43)
# moves focus to the key field — layout-independent, immune to the simulator's
# sticky software-keyboard state.
COMPOSER_X="${COMPOSER_X:-195}"; COMPOSER_Y="${COMPOSER_Y:-437}"

log()  { printf '\033[1;36m[ios-smoke]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[ios-smoke] FAIL:\033[0m %s\n' "$*"; printf '[ios-smoke] artifacts: %s\n' "$ARTIFACTS"; exit 1; }

# ---------- deps ----------
command -v xcodebuild >/dev/null || fail "xcodebuild not found"
command -v python3 >/dev/null || fail "python3 not found"
IDB=""
for py in 3.12 3.11 3.13; do
  [ -x "$HOME/Library/Python/$py/bin/idb" ] && IDB="$HOME/Library/Python/$py/bin/idb" && break
done
[ -n "$IDB" ] || fail "idb client not found (pip install fb-idb under Python 3.12; see .claude/rules/frontend.md)"
command -v idb_companion >/dev/null || fail "idb_companion not found (brew install facebook/fb/idb-companion)"

# Safety: this script WRITES to and HARD-DELETES from whatever backend
# SERVER_URL points at. Refuse anything non-local unless forced.
case "$SERVER_URL" in
  http://localhost*|http://127.0.0.1*) ;;
  *) [ "${FORCE:-0}" = "1" ] || fail "refusing non-local SERVER_URL '$SERVER_URL' — this smoke creates and hard-deletes data (FORCE=1 to override)" ;;
esac

[ -f "$REPO_ROOT/backend/.env" ] || fail "backend/.env not found (cp backend/.env.example backend/.env)"
API_KEY="$(grep '^OPEN_BRAIN_API_KEY=' "$REPO_ROOT/backend/.env" | cut -d= -f2-)"
[ -n "$API_KEY" ] || fail "OPEN_BRAIN_API_KEY missing from backend/.env"

mkdir -p "$ARTIFACTS"
ls -dt "$REPO_ROOT/.ios-smoke"/run-* 2>/dev/null | tail -n +11 | xargs rm -rf 2>/dev/null || true

# ---------- backend ----------
STARTED_BACKEND_PID=""
STARTED_BACKEND_LISTEN_PID=""
cleanup() {
  if [ -n "$STARTED_BACKEND_PID" ]; then
    log "stopping backend we started (pids $STARTED_BACKEND_PID ${STARTED_BACKEND_LISTEN_PID:-?})"
    kill "$STARTED_BACKEND_PID" 2>/dev/null || true
    [ -n "$STARTED_BACKEND_LISTEN_PID" ] && kill "$STARTED_BACKEND_LISTEN_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if ! curl -sf -m 2 "$SERVER_URL/health" | grep -q '"ok":true'; then
  log "backend not reachable — starting local stack"
  (cd "$REPO_ROOT" && docker compose up -d --wait)
  (cd "$REPO_ROOT" && npm run dev:backend > "$ARTIFACTS/backend.log" 2>&1) &
  STARTED_BACKEND_PID=$!
  for _ in $(seq 1 45); do
    curl -sf -m 2 "$SERVER_URL/health" | grep -q '"ok":true' && break
    sleep 2
  done
  curl -sf -m 2 "$SERVER_URL/health" | grep -q '"ok":true' || fail "backend did not become healthy"
  # The subshell PID alone can't tear this down (npm/tsx get reparented) —
  # remember the actual listener so cleanup kills the whole thing.
  STARTED_BACKEND_LISTEN_PID="$(lsof -ti tcp:3001 -sTCP:LISTEN | head -1 || true)"
fi
log "backend healthy at $SERVER_URL"

# ---------- build ----------
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  log "building web bundle + iOS app"
  (cd "$REPO_ROOT/frontend" && npm run build >/dev/null && npx cap sync ios >/dev/null)
  (cd "$REPO_ROOT/frontend/ios/App" && xcodebuild -project App.xcodeproj -scheme App \
    -sdk iphonesimulator -destination "platform=iOS Simulator,name=$DEVICE_NAME" \
    -derivedDataPath ./DerivedData build -quiet) || fail "xcodebuild failed"
else
  log "SKIP_BUILD=1 — reusing $APP_PATH"
fi
[ -d "$APP_PATH" ] || fail "App.app not found at $APP_PATH"

# ---------- simulator ----------
UDID="$(xcrun simctl list devices available -j | DEVICE_NAME="$DEVICE_NAME" python3 -c "
import sys, json, os
want = os.environ['DEVICE_NAME']
data = json.load(sys.stdin)['devices']
for runtime, devs in data.items():
    for d in devs:
        if d['name'] == want:
            print(d['udid']); sys.exit(0)
sys.exit(1)")" || fail "simulator '$DEVICE_NAME' not available (xcrun simctl list devices)"
log "simulator: $DEVICE_NAME ($UDID)"

STATE="$(xcrun simctl list devices | grep "$UDID" | grep -o '(Booted)' || true)"
if [ -z "$STATE" ]; then
  log "booting simulator"
  xcrun simctl boot "$UDID"
  xcrun simctl bootstatus "$UDID" -b >/dev/null
fi

# Kill iOS keyboard smart features for deterministic typed input — smart
# substitution rewrote a typed 'ios-smoke' title into 'iOS-smoke' and broke
# the exact-match verify. Idempotent; standard practice in sim CI setups.
xcrun simctl spawn "$UDID" defaults write com.apple.Preferences KeyboardAutocorrection -bool false 2>/dev/null || true
xcrun simctl spawn "$UDID" defaults write com.apple.Preferences KeyboardAutocapitalization -bool false 2>/dev/null || true
xcrun simctl spawn "$UDID" defaults write com.apple.Preferences KeyboardTextReplacement -bool false 2>/dev/null || true

# Verify matches 'smoke' (case-insensitive — smart-text may recase the typed
# prefix; keyboard prefs above only apply after the next sim reboot) AND
# endswith this run's epoch digits (digits are never rewritten). Both
# conditions guard the hard-delete below from ever selecting a pre-existing
# todo that merely mentions a timestamp.
SMOKE_EPOCH="$(date +%s)"
SMOKE_TITLE="ios-smoke $SMOKE_EPOCH"

find_smoke_ids() {
  curl -sf -H "Authorization: Bearer $API_KEY" "$SERVER_URL/api/v1/todos" | SMOKE_EPOCH="$SMOKE_EPOCH" python3 -c "
import sys, json, os
epoch = os.environ['SMOKE_EPOCH']
todos = json.load(sys.stdin)['todos']
for t in todos:
    c = t.get('content', '')
    if 'smoke' in c.lower() and c.strip().endswith(epoch):
        print(t['id'])"
}

# One complete device pass: fresh install → pre-warm → connect → create →
# verify. HID injection has rare per-step hiccups (swallowed keystrokes,
# taps racing a still-loading page); each step is individually hardened, and
# the whole flow is additionally attempt-looped below so one hiccup never
# fails the smoke — every retry is logged, silence is never flake-masking.
TODO_ID=""
attempt_flow() {
  local n="$1"

  # Fresh install: uninstall clears localStorage → deterministic first-run.
  log "[flow $n] fresh install (clears stored server config)"
  xcrun simctl uninstall "$UDID" "$BUNDLE_ID" 2>/dev/null || true
  xcrun simctl install "$UDID" "$APP_PATH"

  # Cold first launch after install can take 10s+ before the webview renders
  # (observed: only the backdrop painted at +8s, typed input went nowhere).
  # Pre-warm: launch, settle, terminate, relaunch warm — the second launch
  # renders the connect screen promptly and autofocus is reliable.
  log "[flow $n] pre-warming app (cold first launch is slow)"
  xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null
  sleep 12
  xcrun simctl terminate "$UDID" "$BUNDLE_ID" 2>/dev/null || true
  xcrun simctl launch "$UDID" "$BUNDLE_ID" >/dev/null
  sleep 8
  xcrun simctl io "$UDID" screenshot "$ARTIFACTS/f$n-1-connect-screen.png" >/dev/null 2>&1

  # Connect: server field is autofocused; type URL, Tab to the key field,
  # type key, Enter submits (ConnectScreen probes /api/v1/stats, reloads).
  log "[flow $n] driving connect screen"
  # First keystrokes after launch can be swallowed while the focused field's
  # keyboard attachment settles ('http://…' arrived as 'tp://…') — type a
  # sacrificial char and delete it so the URL lands whole.
  "$IDB" ui text --udid "$UDID" "x"
  sleep 1
  "$IDB" ui key --udid "$UDID" 42   # backspace — clears the warm-up char
  sleep 1
  "$IDB" ui text --udid "$UDID" "$SERVER_URL"
  "$IDB" ui key --udid "$UDID" 43   # HID Tab → API key field
  sleep 1
  "$IDB" ui text --udid "$UDID" "$API_KEY"
  "$IDB" ui key --udid "$UDID" 40   # HID Enter → submit
  sleep 12   # probe + persist + reload + Home data fetch
  xcrun simctl io "$UDID" screenshot "$ARTIFACTS/f$n-2-after-connect.png" >/dev/null 2>&1

  # Create: Home's data load time varies (the composer doesn't exist until
  # the Todos section renders) — attempt-looped, not sleep-tuned. A tap that
  # lands on 'Loading…' is harmless; the retry hits the rendered page.
  TODO_ID=""
  local attempt
  for attempt in 1 2 3; do
    log "[flow $n] creating todo via Home composer (attempt $attempt): '$SMOKE_TITLE'"
    "$IDB" ui tap --udid "$UDID" "$COMPOSER_X" "$COMPOSER_Y"
    sleep 1
    "$IDB" ui text --udid "$UDID" "$SMOKE_TITLE"
    "$IDB" ui key --udid "$UDID" 40   # Enter → create
    for _ in $(seq 1 4); do
      sleep 2
      TODO_ID="$(find_smoke_ids | head -1)"
      [ -n "$TODO_ID" ] && break
    done
    [ -n "$TODO_ID" ] && break
    log "[flow $n] not visible yet — retrying create"
  done
  xcrun simctl io "$UDID" screenshot "$ARTIFACTS/f$n-3-after-create.png" >/dev/null 2>&1
  [ -n "$TODO_ID" ]
}

if ! attempt_flow 1; then
  log "full flow attempt 1 failed — retrying once from a fresh install"
  attempt_flow 2 || fail "smoke todo ending in '$SMOKE_EPOCH' never appeared after two full flows — see $ARTIFACTS"
fi
log "todo verified: $TODO_ID"

# ---------- cleanup test data ----------
# Delete EVERY row matching this run (a retried attempt can double-create).
# Fatal on failure: leftovers are exactly what a future matcher could hit.
for id in $(find_smoke_ids); do
  curl -sf -X DELETE -H "Authorization: Bearer $API_KEY" \
    "$SERVER_URL/api/v1/todos/$id?hard=true" >/dev/null \
    || fail "smoke passed but could not delete its todo $id — delete it manually before rerunning"
done

log "PASS — native shell verified end to end (artifacts: $ARTIFACTS)"
