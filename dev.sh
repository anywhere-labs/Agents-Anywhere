#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVER_HOST="${SERVER_HOST:-127.0.0.1}"
SERVER_PORT="${SERVER_PORT:-8000}"
WEB_HOST="${WEB_HOST:-127.0.0.1}"
WEB_PORT="${WEB_PORT:-5173}"
AGENT_SERVER_DB="${AGENT_SERVER_DB:-agent-server.sqlite3}"
AGENTS_ANYWHERE_API="${AGENTS_ANYWHERE_API:-http://${SERVER_HOST}:${SERVER_PORT}}"

if ! command -v uv >/dev/null 2>&1; then
  echo "dev.sh: uv is required but was not found in PATH" >&2
  exit 127
fi

if ! command -v yarn >/dev/null 2>&1; then
  echo "dev.sh: yarn is required but was not found in PATH" >&2
  exit 127
fi

pids=()
shutting_down=0

cleanup() {
  local code=$?
  if ((shutting_down)); then
    exit "$code"
  fi
  shutting_down=1
  trap - INT TERM EXIT
  if ((${#pids[@]} > 0)); then
    kill "${pids[@]}" >/dev/null 2>&1 || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
  exit "$code"
}

trap cleanup INT TERM EXIT

prefix() {
  local name="$1"
  sed -u "s/^/[${name}] /"
}

start_server() {
  (
    cd "${ROOT_DIR}/server"
    AGENT_SERVER_DB="${AGENT_SERVER_DB}" \
      uv run uvicorn agent_server.app:create_app \
        --factory \
        --host "${SERVER_HOST}" \
        --port "${SERVER_PORT}" \
        --reload
  ) 2>&1 | prefix "server" &
  pids+=("$!")
}

start_web() {
  (
    cd "${ROOT_DIR}/web"
    AGENTS_ANYWHERE_API="${AGENTS_ANYWHERE_API}" \
      yarn dev --host "${WEB_HOST}" --port "${WEB_PORT}"
  ) 2>&1 | prefix "web" &
  pids+=("$!")
}

echo "Starting Agents Anywhere dev servers"
echo "  backend: ${AGENTS_ANYWHERE_API}"
echo "  web:     http://${WEB_HOST}:${WEB_PORT}"
echo

start_server
start_web

while true; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      wait "$pid" || true
      exit 1
    fi
  done
  sleep 1
done
