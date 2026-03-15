#!/bin/bash
# scripts/migrate-azure.sh — Run migrations against Azure PostgreSQL
set -euo pipefail

DB_URL="${DATABASE_URL:?Set DATABASE_URL (Azure PostgreSQL connection string with sslmode=require)}"

echo "=== Running migrations against Azure PostgreSQL ==="
psql "${DB_URL}" -f migrations/001_initial_schema.sql

echo "=== Verifying tables ==="
psql "${DB_URL}" -c "\dt"

echo "=== Done! ==="
