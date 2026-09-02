#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${ROOT_DIR}/server/.venv/bin/python"
LOCAL_DIR="${ROOT_DIR}/.local-dev"
RUN_DIR="${LOCAL_DIR}/run"
LOG_DIR="${LOCAL_DIR}/logs"
CONTROL_LOG="${LOG_DIR}/dev-control.log"
COMPOSE_FILE="${ROOT_DIR}/docker/docker-compose.local.yml"
CONTROL_SESSION="aa-dev-control"
ENV_FILE="${AGENTS_ANYWHERE_ENV_FILE:-${ROOT_DIR}/.env.local}"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ENV_FILE}"
  set +a
fi

readonly SERVER_PORT=8000
readonly WEB_PORT=5174
readonly POSTGRES_PORT=55432
readonly REDIS_PORT=56379
readonly CONTROL_PORT=8765
readonly CONTROL_URL="http://127.0.0.1:${CONTROL_PORT}"

# Keep every entry point on the same port contract even if .env.local contains
# values from an older checkout.
export SERVER_PORT WEB_PORT
export AGENTS_ANYWHERE_POSTGRES_PORT="${POSTGRES_PORT}"
export AGENTS_ANYWHERE_REDIS_PORT="${REDIS_PORT}"

usage() {
  cat <<'EOF'
Manage the fixed-port Agents Anywhere local development stack.

Usage:
  ./dev-control.sh start
  ./dev-control.sh stop
  ./dev-control.sh bootstrap
  ./dev-control.sh status
  ./dev-control.sh restart server|web|connector|all
  ./dev-control.sh down
  ./dev-control.sh serve

start/stop manage the optional localhost Dev Control page on port 8765; start
also opens it in the system browser. bootstrap starts a detached PostgreSQL,
Redis, Server and Web stack when no foreground local-up.sh is running. Dev
Control never owns a foreground local-up.sh stack: use Ctrl-C in that terminal
first. down stops the detached local services and containers.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_python() {
  [[ -x "${PYTHON}" ]] || \
    fail "missing Server environment; run ./local-up.sh without --skip-install"
}

session_exists() {
  screen -ls 2>/dev/null | grep -q "[.]$1[[:space:]]"
}

listener_pids() {
  lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u || true
}

open_control_page() {
  case "${AGENTS_ANYWHERE_NO_BROWSER:-}" in
    1|true|TRUE|yes|YES)
      return
      ;;
  esac

  case "$(uname -s)" in
    Darwin)
      if command -v open >/dev/null 2>&1; then
        open "${CONTROL_URL}" >/dev/null 2>&1 || true
      fi
      ;;
    Linux)
      if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && \
        command -v xdg-open >/dev/null 2>&1; then
        xdg-open "${CONTROL_URL}" >/dev/null 2>&1 || true
      fi
      ;;
  esac
}

control_ready() {
  printf 'Dev Control: %s\n' "${CONTROL_URL}"
  open_control_page
}

stop_control() {
  if session_exists "${CONTROL_SESSION}"; then
    screen -S "${CONTROL_SESSION}" -X quit >/dev/null 2>&1 || true
  fi

  local pid
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] && kill -TERM "${pid}" >/dev/null 2>&1 || true
  done < <(listener_pids "${CONTROL_PORT}")

  local tick=0
  while [[ -n "$(listener_pids "${CONTROL_PORT}")" && ${tick} -lt 50 ]]; do
    tick=$((tick + 1))
    sleep 0.1
  done

  while IFS= read -r pid; do
    [[ -n "${pid}" ]] && kill -KILL "${pid}" >/dev/null 2>&1 || true
  done < <(listener_pids "${CONTROL_PORT}")
}

start_control() {
  require_python
  if curl --fail --silent --output /dev/null \
    "${CONTROL_URL}/api/status"; then
    control_ready
    return
  fi

  stop_control
  mkdir -p "${RUN_DIR}" "${LOG_DIR}"
  chmod 700 "${LOCAL_DIR}"
  : >"${CONTROL_LOG}"

  local command
  printf -v command 'cd %q && exec %q -m devtools.control serve --host 127.0.0.1 --port %q >> %q 2>&1' \
    "${ROOT_DIR}" "${PYTHON}" "${CONTROL_PORT}" "${CONTROL_LOG}"
  screen -dmS "${CONTROL_SESSION}" bash -c "${command}"

  local tick=0
  while ((tick < 100)); do
    if curl --fail --silent --output /dev/null \
      "${CONTROL_URL}/api/status"; then
      control_ready
      return
    fi
    tick=$((tick + 1))
    sleep 0.1
  done
  fail "Dev Control did not become ready; check ${CONTROL_LOG}"
}

down_stack() {
  if [[ -x "${PYTHON}" ]]; then
    "${PYTHON}" -m devtools.control stop all
  fi
  stop_control
  for session in aa-dev-server aa-dev-web aa-dev-connector aa-source-connector; do
    if session_exists "${session}"; then
      screen -S "${session}" -X quit >/dev/null 2>&1 || true
    fi
  done
  if docker info >/dev/null 2>&1; then
    docker compose -f "${COMPOSE_FILE}" down --remove-orphans
  fi
  printf 'Agents Anywhere local stack stopped.\n'
}

case "${1:-start}" in
  start)
    [[ $# -le 1 ]] || fail "start does not accept extra arguments"
    start_control
    ;;
  stop)
    [[ $# -eq 1 ]] || fail "stop does not accept extra arguments"
    stop_control
    ;;
  bootstrap)
    [[ $# -eq 1 ]] || fail "bootstrap does not accept extra arguments"
    require_python
    exec "${PYTHON}" -m devtools.control bootstrap
    ;;
  status)
    [[ $# -eq 1 ]] || fail "status does not accept extra arguments"
    require_python
    exec "${PYTHON}" -m devtools.control status
    ;;
  restart)
    [[ $# -eq 2 ]] || fail "usage: ./dev-control.sh restart server|web|connector|all"
    case "$2" in
      server|web|connector|all) ;;
      *) fail "unsupported restart target: $2" ;;
    esac
    require_python
    exec "${PYTHON}" -m devtools.control restart "$2"
    ;;
  down)
    [[ $# -eq 1 ]] || fail "down does not accept extra arguments"
    down_stack
    ;;
  serve)
    [[ $# -eq 1 ]] || fail "serve does not accept extra arguments"
    require_python
    exec "${PYTHON}" -m devtools.control serve \
      --host 127.0.0.1 --port "${CONTROL_PORT}"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
