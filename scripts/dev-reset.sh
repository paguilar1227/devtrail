#!/usr/bin/env bash
# scripts/dev-reset.sh — nuclear option. Stops everything AND wipes data.
#
# Removes Postgres + Azurite volumes. Useful when migrations get tangled or
# you want a clean slate before reseeding. Re-run scripts/dev-up.sh after.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

read -p "This wipes Postgres + Azurite volumes. Continue? [y/N] " confirm
case "$confirm" in
  y|Y|yes|YES) ;;
  *) echo "aborted"; exit 0 ;;
esac

docker compose down -v
echo "✓ data wiped. Run 'bash scripts/dev-up.sh' to start fresh."
