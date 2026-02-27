#!/bin/bash
set -e
cd "$(dirname "$0")"

# Kill stale processes
for port in 3000 5173 5174; do
  lsof -ti:"$port" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
done

# Start postgres (idempotent — does nothing if already running)
docker compose up -d
echo "⏳ Waiting for DB..."
until docker exec bg-tracker-db pg_isready -U bg_tracker -q 2>/dev/null; do sleep 1; done
echo "✅ DB ready"

# Run schema upgrades (safe to run every time — never destroys data)
docker exec -i bg-tracker-db psql -U bg_tracker -d bg_tracker -q -f /docker-entrypoint-initdb.d/upgrade.sql >/dev/null 2>&1 || true

# Backup (skip if unchanged)
mkdir -p backups
DUMP=$(docker exec bg-tracker-db pg_dump -U bg_tracker bg_tracker 2>/dev/null) || true
if [ -n "$DUMP" ]; then
  LATEST=$(ls -1t backups/bg_tracker_*.sql 2>/dev/null | head -1)
  NEW_HASH=$(echo "$DUMP" | md5sum | awk '{print $1}')
  OLD_HASH=""
  [ -n "$LATEST" ] && OLD_HASH=$(md5sum < "$LATEST" | awk '{print $1}')
  if [ "$NEW_HASH" != "$OLD_HASH" ]; then
    FILE="backups/bg_tracker_$(date +%Y%m%d_%H%M%S).sql"
    echo "$DUMP" > "$FILE"
    echo "💾 Backup → $FILE"
  fi
  # Keep last 20
  ls -1t backups/bg_tracker_*.sql 2>/dev/null | tail -n +21 | xargs -r rm --
fi

# Start backend
(cd backend && cargo run) &
BACKEND_PID=$!
echo "⏳ Waiting for backend..."
for i in $(seq 1 90); do
  kill -0 $BACKEND_PID 2>/dev/null || { echo "❌ Backend crashed"; exit 1; }
  curl -sf http://localhost:3000/api/health >/dev/null 2>&1 && break
  [ "$i" -eq 90 ] && { echo "❌ Backend timeout"; kill $BACKEND_PID; exit 1; }
  sleep 1
done
echo "✅ Backend ready"

# Start frontend
(cd frontend && npm run dev) &
FRONTEND_PID=$!
sleep 3
echo ""
echo "✅ Running → http://localhost:5173"
echo "   Ctrl+C to stop"

cleanup() {
  echo "🛑 Stopping..."
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
  docker compose stop 2>/dev/null
  echo "✅ Stopped"
  exit 0
}
trap cleanup SIGINT SIGTERM
wait
