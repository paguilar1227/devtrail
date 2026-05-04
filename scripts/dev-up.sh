#!/usr/bin/env bash
# scripts/dev-up.sh — one-shot local dev bring-up.
#
# Idempotent: safe to re-run. Brings Open Brain to a working state from any
# starting point (fresh clone, partial install, missing .env, empty DB).
#
# What it does, in order:
#   1. Verify prereqs (docker daemon, node 20+).
#   2. Create backend/.env from .env.example if missing (defaults to stub mode).
#   3. npm install in root, backend, frontend if node_modules missing.
#   4. docker compose up -d --wait  (Postgres + Azurite, both healthy).
#   5. Schedule a one-shot seed if the DB has no projects.
#   6. exec into `npm run dev:full` — backend (3001) + frontend (5173) with HMR.
#
# Stop with Ctrl-C. Compose stays up; tear it down with `npm run compose:down`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---- 1. Prereqs ----
command -v docker >/dev/null || fail "docker not on PATH"
docker info >/dev/null 2>&1 || fail "Docker daemon is not running — start Docker Desktop"
command -v node >/dev/null || fail "node not on PATH (need 20+)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || fail "node 20+ required (have v$NODE_MAJOR)"
ok "prereqs ok (docker running, node v$NODE_MAJOR)"

# ---- 2. backend/.env ----
if [ ! -f backend/.env ]; then
  step "creating backend/.env from backend/.env.example"
  cp backend/.env.example backend/.env
  warn "default is stub mode (LLM_PROVIDER=stub). Edit backend/.env if you need real LLM keys."
else
  ok "backend/.env present"
fi

# ---- 3. node_modules ----
if [ ! -d node_modules ]; then step "installing root deps"; npm ci; fi
if [ ! -d backend/node_modules ]; then step "installing backend deps"; (cd backend && npm ci); fi
if [ ! -d frontend/node_modules ]; then step "installing frontend deps"; (cd frontend && npm ci); fi
ok "all node_modules present"

# ---- 4. Compose ----
step "bringing up Postgres + Azurite (docker compose up -d --wait)"
docker compose up -d --wait
ok "postgres + azurite healthy"

# ---- 5. Seed if empty ----
# `projects` doesn't exist until backend runs its first migration. Two cases:
#   (a) table missing → backend will create it on boot, then we seed.
#   (b) table present but empty → seed.
#   (c) table has rows → skip.
SEED=0
PROJECT_COUNT=$(docker exec open-brain-v2-postgres-1 \
  psql -U openbrain openbrain -tAc "SELECT count(*) FROM projects" 2>/dev/null || echo "missing")
case "$PROJECT_COUNT" in
  missing) warn "projects table not present yet (backend will run migrations on first boot)"; SEED=1 ;;
  0)       warn "DB empty"; SEED=1 ;;
  *)       ok "DB already has $PROJECT_COUNT projects — skipping seed" ;;
esac

if [ "$SEED" = "1" ]; then
  step "scheduling background seed (runs once backend is reachable on :3001)"
  # Background sub-shell: poll /health, then run seed once. 60s budget.
  (
    for i in $(seq 1 60); do
      if curl -fsS http://localhost:3001/health >/dev/null 2>&1; then
        printf '\n\033[1;36m▸ seeding local DB\033[0m\n'
        npm run seed:local 2>&1 | sed 's/^/  /'
        exit 0
      fi
      sleep 1
    done
    printf '\033[1;33m! backend never came up — skipping seed\033[0m\n'
  ) &
fi

# ---- 6. Hand off to dev:full ----
echo
echo "  ▸ Web UI:    http://localhost:5173"
echo "  ▸ Backend:   http://localhost:3001"
echo "  ▸ API key:   local-dev-key-not-secret  (in backend/.env)"
echo "  ▸ Stop:      Ctrl-C, then 'npm run compose:down' to free ports"
echo

exec npm run dev:full
