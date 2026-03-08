#!/bin/bash
set -e
cd "$(dirname "$0")"

# Kill stale processes
for port in 3000 5173 5174; do
  lsof -ti:"$port" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
done

## If something is listening on the host Postgres port, try to stop it.
## Handle multiple listeners (IPv4/IPv6 docker-proxy) and prefer stopping containers.
LSOF_CMD="lsof -ti:5432 -sTCP:LISTEN -nP 2>/dev/null || true"
PIDS=$(eval "$LSOF_CMD")
# Fall back to sudo if we didn't see any listeners (docker-proxy runs as root)
if [ -z "$PIDS" ]; then
  PIDS=$(sudo sh -c "$LSOF_CMD") || true
fi
if [ -n "$PIDS" ]; then
  echo "Port 5432 appears in use — inspecting listeners..."
  
  
  
  
  
  
  
  
  
  PIDS="$PIDS"
  for LIST_PID in $PIDS; do
    COMM=$(ps -p $LIST_PID -o comm= 2>/dev/null || true)
    echo " - Listener PID $LIST_PID ($COMM)"
    # read cmdline; if not readable, use sudo
    if CMDLINE=$(tr '\0' ' ' < /proc/$LIST_PID/cmdline 2>/dev/null || true); then
      :
    else
      CMDLINE=$(sudo tr '\0' ' ' < /proc/$LIST_PID/cmdline 2>/dev/null || true)
    fi
    if echo "$CMDLINE" | grep -q docker-proxy; then
      echo "   detected docker-proxy; attempting to identify container..."
      CONTAINER_IP=$(echo "$CMDLINE" | sed -n 's/.*-container-ip \([^ ]*\).*/\1/p')
      if [ -n "$CONTAINER_IP" ]; then
        # Try to match any container (running or not) with that IP.
        CONTAINER_ID=$(docker ps -a -q | xargs -r docker inspect --format '{{.Id}} {{range $k,$v := .NetworkSettings.Networks}}{{$v.IPAddress}} {{end}}' | awk -v ip="$CONTAINER_IP" '$0 ~ ip {print $1; exit}') || true
        if [ -n "$CONTAINER_ID" ]; then
          echo "   stopping container $CONTAINER_ID (IP $CONTAINER_IP)..."
          docker stop "$CONTAINER_ID" >/dev/null 2>&1 || docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true
          sleep 1
        else
          echo "   no container matched IP $CONTAINER_IP"
        fi
      else
        echo "   could not parse container IP from docker-proxy commandline"
      fi
    else
      echo "   listener is not docker-proxy: $CMDLINE"
    fi

    # If the listener still exists, try to kill it (use sudo if necessary).
    # If the listener still exists, try to kill it (use sudo if necessary).
    # Re-check with sudo as lsof may require it.
    STILL=$(lsof -ti:5432 -sTCP:LISTEN -nP 2>/dev/null || true)
    if [ -z "$STILL" ]; then
      STILL=$(sudo lsof -ti:5432 -sTCP:LISTEN -nP 2>/dev/null || true)
    fi
    if [ -n "$STILL" ]; then
      echo "   listener still present. Attempting to kill PID $LIST_PID..."
      kill "$LIST_PID" 2>/dev/null || sudo kill "$LIST_PID" 2>/dev/null || sudo kill -9 "$LIST_PID" 2>/dev/null || kill -9 "$LIST_PID" 2>/dev/null || true
      sleep 1
    fi
  done
fi


# Start postgres (idempotent — does nothing if already running)
# If host port 5432 is already in use, pick an available port and export PG_PORT
if lsof -ti:5432 >/dev/null 2>&1; then
  echo "Host port 5432 is in use — searching for alternate port..."
  for p in $(seq 5433 5500); do
    if ! lsof -ti:"$p" >/dev/null 2>&1; then
      export PG_PORT=$p
      echo "Using host port $PG_PORT for Postgres (set PG_PORT)"
      break
    fi
  done
  if [ -z "$PG_PORT" ]; then
    echo "❌ No available ports found between 5433-5500; please free 5432 or set PG_PORT." >&2
    exit 1
  fi
else
  export PG_PORT=5432
fi

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
