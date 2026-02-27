#!/bin/bash
# BG Tracker - Restore database from a backup SQL file
# Usage: ./scripts/restore.sh <backup_file.sql>
#
# ⚠️  This will DROP and recreate the entire database!
# A pre-restore backup is automatically created first.
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$PROJECT_DIR/backups"

if [ -z "$1" ]; then
  echo "Usage: $0 <backup_file.sql>"
  echo ""
  echo "Available backups:"
  ls -1t "$BACKUP_DIR"/bg_tracker_*.sql 2>/dev/null | while read f; do
    echo "  $f  ($(wc -c < "$f") bytes, $(stat -c %y "$f" 2>/dev/null | cut -d. -f1))"
  done
  exit 1
fi

RESTORE_FILE="$1"
if [ ! -f "$RESTORE_FILE" ]; then
  echo "❌ File not found: $RESTORE_FILE"
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q '^bg-tracker-db$'; then
  echo "❌ Database container is not running. Start it first."
  exit 1
fi

echo "⚠️  This will REPLACE ALL current data with the backup."
echo "   Restore from: $RESTORE_FILE"
echo ""
read -p "Are you sure? (type YES to confirm): " confirm
if [ "$confirm" != "YES" ]; then
  echo "Cancelled."
  exit 0
fi

# Safety backup before restore
echo ""
echo "💾 Creating pre-restore safety backup..."
mkdir -p "$BACKUP_DIR"
SAFETY="$BACKUP_DIR/bg_tracker_pre_restore_$(date +%Y%m%d_%H%M%S).sql"
docker exec bg-tracker-db pg_dump -U bg_tracker bg_tracker > "$SAFETY"
echo "   Saved: $SAFETY"

# Drop and recreate the database, then restore
echo ""
echo "🔄 Restoring database..."
docker exec -i bg-tracker-db psql -U bg_tracker -d postgres -c "
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'bg_tracker' AND pid <> pg_backend_pid();
" > /dev/null 2>&1 || true
docker exec -i bg-tracker-db psql -U bg_tracker -d postgres -c "DROP DATABASE IF EXISTS bg_tracker;" > /dev/null 2>&1
docker exec -i bg-tracker-db psql -U bg_tracker -d postgres -c "CREATE DATABASE bg_tracker OWNER bg_tracker;" > /dev/null 2>&1
docker exec -i bg-tracker-db psql -U bg_tracker -d bg_tracker < "$RESTORE_FILE" > /dev/null 2>&1

echo "✅ Database restored from: $RESTORE_FILE"
echo ""
echo "📊 Restored data:"
docker exec bg-tracker-db psql -U bg_tracker -d bg_tracker -c "
  SELECT 'users' AS table_name, count(*) FROM users
  UNION ALL SELECT 'vendors', count(*) FROM vendors
  UNION ALL SELECT 'items', count(*) FROM items
  UNION ALL SELECT 'destinations', count(*) FROM destinations
  UNION ALL SELECT 'invoices', count(*) FROM invoices
  UNION ALL SELECT 'purchases', count(*) FROM purchases
  UNION ALL SELECT 'payouts', count(*) FROM payouts
  ORDER BY table_name;
"
echo ""
echo "⚠️  Restart the backend to pick up the changes."
