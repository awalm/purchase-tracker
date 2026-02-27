#!/bin/bash
# Restore database from a backup file
# Usage: ./restore.sh backups/bg_tracker_20260218_010850.sql
set -e
cd "$(dirname "$0")"

FILE="${1:?Usage: ./restore.sh <backup.sql>}"
[ -f "$FILE" ] || { echo "❌ File not found: $FILE"; exit 1; }

docker compose up -d
echo "⏳ Waiting for DB..."
until docker exec bg-tracker-db pg_isready -U bg_tracker -q 2>/dev/null; do sleep 1; done

echo "🔄 Restoring from $(basename "$FILE")..."
docker exec bg-tracker-db psql -U bg_tracker -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='bg_tracker' AND pid != pg_backend_pid();" >/dev/null 2>&1
docker exec bg-tracker-db psql -U bg_tracker -d postgres -c "DROP DATABASE IF EXISTS bg_tracker;" >/dev/null 2>&1
docker exec bg-tracker-db psql -U bg_tracker -d postgres -c "CREATE DATABASE bg_tracker OWNER bg_tracker;" >/dev/null 2>&1
docker exec -i bg-tracker-db psql -U bg_tracker -d bg_tracker < "$FILE"

# Run schema upgrades so old backups get new columns
docker exec -i bg-tracker-db psql -U bg_tracker -d bg_tracker -f /docker-entrypoint-initdb.d/upgrade.sql 2>/dev/null || true

echo "✅ Restored from $(basename "$FILE")"
echo "   Run ./start.sh to start the app"
