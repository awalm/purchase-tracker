#!/bin/bash
# BG Tracker - Backup database to SQL file
# Usage: ./scripts/backup.sh [optional_filename]
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$PROJECT_DIR/backups"
mkdir -p "$BACKUP_DIR"

if ! docker ps --format '{{.Names}}' | grep -q '^bg-tracker-db$'; then
  echo "❌ Database container is not running. Start it first."
  exit 1
fi

STAMP=$(date +%Y%m%d_%H%M%S)
FILE="${1:-$BACKUP_DIR/bg_tracker_${STAMP}.sql}"

echo "💾 Backing up database..."
docker exec bg-tracker-db pg_dump -U bg_tracker bg_tracker > "$FILE"
SIZE=$(wc -c < "$FILE")
echo "✅ Backup saved: $FILE ($SIZE bytes)"

# Show row counts
echo ""
echo "📊 Current data:"
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
echo "📂 All backups:"
ls -lh "$BACKUP_DIR"/bg_tracker_*.sql 2>/dev/null | awk '{print "   " $NF " (" $5 ")"}'
