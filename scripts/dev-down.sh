#!/usr/bin/env bash
# scripts/dev-down.sh — stop local dev services (graceful).
#
# Stops the compose stack (Postgres + Azurite). Does NOT touch volumes —
# your seeded data survives. Use scripts/dev-reset.sh to wipe data too.
#
# Backend + frontend processes started by dev-up.sh are killed by Ctrl-C in
# that terminal — this script only handles the docker side.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
docker compose down
echo "✓ compose stopped (data preserved)"
