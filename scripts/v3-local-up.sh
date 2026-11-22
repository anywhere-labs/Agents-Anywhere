#!/usr/bin/env bash
# Local AA v3 stack for development and end-to-end checks:
#   PostgreSQL + Redis (Docker) → meshcall-router → server-v3 → web-v3, optionally connector-v3.
#
#   scripts/v3-local-up.sh            start (idempotent; keeps data)
#   scripts/v3-local-up.sh --with-connector   also register and start a Connector on this machine
#   scripts/v3-local-up.sh --down     stop everything started here (data volumes kept)
#   scripts/v3-local-up.sh --status
#
# State, logs and pids live in .local-dev/v3/. Ports can be overridden with the env vars below.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${AA_V3_STATE_DIR:-$ROOT/.local-dev/v3}"
PG_PORT="${AA_V3_PG_PORT:-55482}"
REDIS_PORT="${AA_V3_REDIS_PORT:-56429}"
ROUTER_PORT="${AA_V3_ROUTER_PORT:-7690}"
CONTROL_PORT="${AA_V3_CONTROL_PORT:-8790}"
WEB_PORT="${AA_V3_WEB_PORT:-3011}"
S3_PORT="${AA_V3_S3_PORT:-59000}"
DRIVE="${AA_V3_DRIVE:-1}" # 1: start an in-memory S3 (moto) so the cloud drive works; 0: no drive
ROUTER_PASSWORD="${AA_V3_ROUTER_PASSWORD:-control-dev-password}"
PG_NAME=aa-v3-local-pg
REDIS_NAME=aa-v3-local-redis
ADMIN_EMAIL="${AA_V3_ADMIN_EMAIL:-dev@aa.local}"
ADMIN_PASSWORD="${AA_V3_ADMIN_PASSWORD:-aa-dev-password}"

# Browser origins allowed to call the Router and the control plane: the Web port plus 3012–3019 for side-by-side dev
# servers (other branches, Desktop's renderer). Override with AA_V3_ORIGINS (comma-separated).
ORIGINS="${AA_V3_ORIGINS:-$(for p in "$WEB_PORT" 3012 3013 3014 3015 3016 3017 3018 3019; do printf 'http://127.0.0.1:%s,http://localhost:%s,' "$p" "$p"; done | sed 's/,$//')}"

mkdir -p "$STATE"
log() { printf '\033[1;34m[v3]\033[0m %s\n' "$*"; }

router_bin() {
  local bin
  for bin in "${MESHCALL_ROUTER_BINARY:-}" \
    "$ROOT"/connector-v3/node_modules/meshcall-router-*/bin/meshcall-router; do
    [[ -n "$bin" && -x "$bin" ]] && { echo "$bin"; return; }
  done
  command -v meshcall-router || { echo "meshcall-router not found: run 'yarn install' in connector-v3 or set MESHCALL_ROUTER_BINARY" >&2; exit 1; }
}

alive() { [[ -f "$STATE/$1.pid" ]] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }

start_bg() { # name, then command…
  local name="$1"; shift
  if alive "$name"; then log "$name already running (pid $(cat "$STATE/$name.pid"))"; return; fi
  nohup "$@" >"$STATE/$name.log" 2>&1 &
  echo $! >"$STATE/$name.pid"
  log "$name started (pid $!, log $STATE/$name.log)"
}

stop_bg() {
  local name="$1"
  if alive "$name"; then
    local pid; pid="$(cat "$STATE/$name.pid")"
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL "$pid" 2>/dev/null || true
    log "$name stopped"
  fi
  rm -f "$STATE/$name.pid"
}

wait_http() { # url, label
  for _ in $(seq 1 120); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 0.5; done
  echo "timed out waiting for $2 ($1)" >&2; return 1
}

control_env() {
  export AA_CONTROL_DB_URL="postgresql+asyncpg://postgres:postgres@127.0.0.1:$PG_PORT/aa_v3_local"
  export AA_CONTROL_REDIS_URL="redis://127.0.0.1:$REDIS_PORT/0"
  export AA_CONTROL_SECRET="${AA_CONTROL_SECRET:-aa-v3-local-dev-secret-0123456789abcdef}"
  export AA_CONTROL_PUBLIC_ORIGIN="http://127.0.0.1:$CONTROL_PORT"
  export AA_CONTROL_HOST=127.0.0.1 AA_CONTROL_PORT="$CONTROL_PORT"
  export AA_CONTROL_ROUTER_URL="ws://127.0.0.1:$ROUTER_PORT"
  export AA_CONTROL_ROUTER_PUBLIC_URL="ws://127.0.0.1:$ROUTER_PORT"
  export AA_CONTROL_ROUTER_USERNAME=control AA_CONTROL_ROUTER_PASSWORD="$ROUTER_PASSWORD"
  export AA_CONTROL_CORS_ORIGINS="$ORIGINS"
  if [[ "$DRIVE" == 1 ]]; then
    export AA_CONTROL_S3_ENDPOINT="http://127.0.0.1:$S3_PORT" AA_CONTROL_S3_BUCKET=aa-drive
    export AA_CONTROL_S3_ACCESS_KEY_ID=aa-dev AA_CONTROL_S3_SECRET_ACCESS_KEY=aa-dev-secret AA_CONTROL_S3_PATH_STYLE=true
  fi
}

write_router_auth() {
  python3 - "$STATE/router-auth.json" "$ROUTER_PASSWORD" <<'PY'
import hashlib, json, os, sys
path, password = sys.argv[1], sys.argv[2]
salt = os.urandom(16)
key = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 600000)
services = ["aa.v3.Control", "aa.v3.Sessions", "aa.v3.Terminals", "aa.v3.Device", "aa.v3.DeviceAdmin"]
doc = {"users": [{
    "username": "control",
    "password_hash": f"pbkdf2-sha256$600000${salt.hex()}${key.hex()}",
    "roles": ["client", "server"],
    "register": services,
    "call": [f"{s}/*" for s in services] + [
        "meshcall.router.v1.AuthService/*", "meshcall.router.v1.TunnelService/*", "meshcall.router.v1.Registry/*"],
}]}
with open(path, "w") as f:
    json.dump(doc, f)
os.chmod(path, 0o600)
PY
}

up() {
  log "PostgreSQL :$PG_PORT, Redis :$REDIS_PORT"
  docker inspect "$PG_NAME" >/dev/null 2>&1 || docker run -d --name "$PG_NAME" -e POSTGRES_PASSWORD=postgres \
    -v aa-v3-local-pg:/var/lib/postgresql/data -p "127.0.0.1:$PG_PORT:5432" postgres:17 >/dev/null
  docker inspect "$REDIS_NAME" >/dev/null 2>&1 || docker run -d --name "$REDIS_NAME" \
    -p "127.0.0.1:$REDIS_PORT:6379" redis:8-alpine >/dev/null
  docker start "$PG_NAME" "$REDIS_NAME" >/dev/null
  for _ in $(seq 1 60); do docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 0.5; done
  docker exec "$PG_NAME" psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='aa_v3_local'" | grep -q 1 \
    || docker exec "$PG_NAME" createdb -U postgres aa_v3_local

  [[ -f "$STATE/router-auth.json" ]] || write_router_auth
  start_bg router "$(router_bin)" -host 127.0.0.1 -port "$ROUTER_PORT" -auth-file "$STATE/router-auth.json" \
    -http-cors-origin "$ORIGINS"

  if [[ "$DRIVE" == 1 ]]; then
    # In-memory S3 for the cloud drive (data is lost when it stops; fine for development).
    start_bg s3 uvx --from "moto[server]" moto_server -H 127.0.0.1 -p "$S3_PORT"
    wait_http "http://127.0.0.1:$S3_PORT/" "S3 (moto)"
    curl -fsS -o /dev/null -X PUT "http://127.0.0.1:$S3_PORT/aa-drive" || true
  fi

  control_env
  (cd "$ROOT/server-v3" && uv sync -q && uv run -q alembic upgrade head)
  start_bg control bash -c "cd '$ROOT/server-v3' && exec uv run -q python -m aa_control.main"
  wait_http "http://127.0.0.1:$CONTROL_PORT/readyz" "server-v3"

  if [[ ! -d "$ROOT/web-v3/node_modules" ]]; then (cd "$ROOT/web-v3" && corepack yarn install); fi
  start_bg web bash -c "cd '$ROOT/web-v3' && AA_CONTROL_SERVER_URL='http://127.0.0.1:$CONTROL_PORT' exec node_modules/.bin/next dev -H 127.0.0.1 -p '$WEB_PORT'"
  wait_http "http://127.0.0.1:$WEB_PORT/sign-in" "web-v3"

  ensure_admin
  log "Web:      http://127.0.0.1:$WEB_PORT  (login $ADMIN_EMAIL / $ADMIN_PASSWORD)"
  log "Control:  http://127.0.0.1:$CONTROL_PORT   Router: ws://127.0.0.1:$ROUTER_PORT"
}

ensure_admin() {
  local body="{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"display_name\":\"Dev\"}"
  curl -fsS -o /dev/null -H 'content-type: application/json' -d "$body" "http://127.0.0.1:$CONTROL_PORT/auth/register" 2>/dev/null || true
  curl -fsS -H 'content-type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
    "http://127.0.0.1:$CONTROL_PORT/auth/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])' >"$STATE/access-token"
}

connector_up() {
  local dir="$STATE/connector"
  export AA_CONNECTOR_DATA_DIR="$dir"
  (cd "$ROOT/connector-v3" && { [[ -d node_modules ]] || corepack yarn install; } && corepack yarn build >/dev/null)
  if [[ ! -f "$dir/identity.json" ]]; then
    ensure_admin
    node "$ROOT/connector-v3/dist/src/cli.js" register --control-url "http://127.0.0.1:$CONTROL_PORT" \
      --access-token "$(cat "$STATE/access-token")" --name "$(scutil --get ComputerName 2>/dev/null || hostname) (v3 local)"
  fi
  local presets=()
  [[ -f "$STATE/presets.json" ]] && presets=(--presets "$STATE/presets.json")
  start_bg connector env AA_CONNECTOR_DATA_DIR="$dir" node "$ROOT/connector-v3/dist/src/cli.js" start ${presets[@]+"${presets[@]}"}
}

down() {
  stop_bg connector; stop_bg web; stop_bg control; stop_bg router; stop_bg s3
  docker stop "$PG_NAME" "$REDIS_NAME" >/dev/null 2>&1 || true
  log "stopped (data kept in Docker volume aa-v3-local-pg and $STATE)"
}

status() {
  for n in s3 router control web connector; do
    if alive "$n"; then echo "$n: running (pid $(cat "$STATE/$n.pid"))"; else echo "$n: stopped"; fi
  done
  docker ps --filter "name=aa-v3-local" --format '{{.Names}}: {{.Status}}'
}

case "${1:-}" in
  --down) down ;;
  --status) status ;;
  --with-connector) up; connector_up ;;
  "") up ;;
  *) echo "usage: $0 [--with-connector|--down|--status]" >&2; exit 2 ;;
esac
