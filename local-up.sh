#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="${ROOT_DIR}/server"
WEB_DIR="${ROOT_DIR}/web-next"
CONNECTOR_DIR="${ROOT_DIR}/connector"
COMPOSE_FILE="${ROOT_DIR}/docker/docker-compose.local.yml"
LOCAL_DIR="${ROOT_DIR}/.local-dev"
CONNECTOR_CONFIG="${LOCAL_DIR}/connector-source.json"

ENV_FILE="${AGENTS_ANYWHERE_ENV_FILE:-${ROOT_DIR}/.env.local}"
ENV_FILE_EXPLICIT=false
SKIP_INSTALL=false
WITH_CONNECTOR=false
CONNECTOR_CONFIG_SOURCE=""

usage() {
  cat <<'EOF'
Start the complete local Agents Anywhere development stack.

Usage:
  ./local-up.sh [options]

Options:
  --env-file PATH       Load application environment variables from PATH
  --skip-install        Reuse the existing Python and Web dependencies
  --with-connector      Start Connector from the saved local credential
  --connector-config P  Import a Connector JSON config, then start Connector
  -h, --help            Show this help

Fixed local ports:
  Web 5174, Server 8000, PostgreSQL 55432, Redis 56379, Dev Control 8765.

The launcher requires a running Docker daemon. It stops anything listening on
the fixed ports, starts PostgreSQL and Redis, then starts Server, Web and the
localhost-only Dev Control page as background services. Connector stays off
unless --with-connector is supplied or it is started from Dev Control.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ $# -ge 2 ]] || fail "--env-file requires a path"
      ENV_FILE="$2"
      ENV_FILE_EXPLICIT=true
      shift 2
      ;;
    --skip-install)
      SKIP_INSTALL=true
      shift
      ;;
    --with-connector)
      WITH_CONNECTOR=true
      shift
      ;;
    --connector-config)
      [[ $# -ge 2 ]] || fail "--connector-config requires a path"
      CONNECTOR_CONFIG_SOURCE="$2"
      WITH_CONNECTOR=true
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
elif [[ "${ENV_FILE_EXPLICIT}" == true ]]; then
  fail "environment file not found: ${ENV_FILE}"
fi

# Local development uses one predictable set of ports. Define these after the
# env file is loaded so stale overrides are replaced instead of causing a
# readonly-variable error while sourcing.
readonly SERVER_PORT=8000
readonly WEB_PORT=5174
readonly POSTGRES_PORT=55432
readonly REDIS_PORT=56379
readonly CONTROL_PORT=8765
export AGENTS_ANYWHERE_ENV_FILE="${ENV_FILE}"

for command in corepack curl docker grep install lsof ps screen sort uv; do
  require_command "${command}"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

# Do this before stopping anything. A missing Docker daemon must never leave a
# previously working local stack half-stopped.
if ! docker info >/dev/null 2>&1; then
  fail "Docker is not running. Start Docker, then run ./local-up.sh again"
fi

listener_pids() {
  local port="$1"
  lsof -nP -t -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null | sort -u || true
}

port_is_free() {
  [[ -z "$(listener_pids "$1")" ]]
}

stop_screen_session() {
  local session="$1"
  if screen -ls 2>/dev/null | grep -q "[.]${session}[[:space:]]"; then
    printf '[ports] stopping old session %s\n' "${session}"
    screen -S "${session}" -X quit >/dev/null 2>&1 || true
  fi
}

stop_docker_publishers() {
  local port="$1"
  local container_id
  while IFS= read -r container_id; do
    [[ -n "${container_id}" ]] || continue
    printf '[ports] stopping Docker container %s on port %s\n' \
      "${container_id}" "${port}"
    docker stop "${container_id}" >/dev/null
  done < <(docker ps --filter "publish=${port}" --format '{{.ID}}')
}

kill_port() {
  local port="$1"
  local label="$2"
  local attempt=0

  while ((attempt < 3)); do
    local pids=()
    local pid
    while IFS= read -r pid; do
      [[ -n "${pid}" ]] && pids+=("${pid}")
    done < <(listener_pids "${port}")
    ((${#pids[@]} > 0)) || return 0

    printf '[ports] releasing %s port %s (PID %s)\n' \
      "${label}" "${port}" "${pids[*]}"
    for pid in "${pids[@]}"; do
      local command
      command="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
      case "${command}" in
        *com.docker.backend*|*Docker.app*)
          fail "${label} port ${port} is still held by Docker itself; refusing to stop the Docker daemon"
          ;;
      esac
      kill -TERM "${pid}" >/dev/null 2>&1 || true
    done

    local tick=0
    while ((tick < 50)); do
      port_is_free "${port}" && return 0
      tick=$((tick + 1))
      sleep 0.1
    done

    while IFS= read -r pid; do
      [[ -n "${pid}" ]] && kill -KILL "${pid}" >/dev/null 2>&1 || true
    done < <(listener_pids "${port}")
    attempt=$((attempt + 1))
  done

  port_is_free "${port}" || fail "could not release ${label} port ${port}"
}

mkdir -p "${LOCAL_DIR}/logs" "${LOCAL_DIR}/files"
chmod 700 "${LOCAL_DIR}"

# Stop both the current split layout and older one-process launch layouts.
for session in \
  aa-dev-control aa-dev-server aa-dev-web aa-dev-connector \
  aa-local-stack aa-agents-anywhere-local aa-source-connector; do
  stop_screen_session "${session}"
done

# Project-owned database containers are stopped first. If a different
# container publishes one of our fixed infrastructure ports, stop that exact
# container instead of killing Docker Desktop.
docker compose -f "${COMPOSE_FILE}" down --remove-orphans >/dev/null 2>&1 || true
stop_docker_publishers "${POSTGRES_PORT}"
stop_docker_publishers "${REDIS_PORT}"

kill_port "${CONTROL_PORT}" "Dev Control"
kill_port "${SERVER_PORT}" "Server"
kill_port "${WEB_PORT}" "Web"
kill_port "${POSTGRES_PORT}" "PostgreSQL"
kill_port "${REDIS_PORT}" "Redis"

if [[ "${SKIP_INSTALL}" != true ]]; then
  printf '[setup] syncing Server dependencies\n'
  (cd "${SERVER_DIR}" && UV_NO_PROGRESS=1 uv sync)

  printf '[setup] syncing Connector dependencies\n'
  (cd "${CONNECTOR_DIR}" && UV_NO_PROGRESS=1 uv sync)

  printf '[setup] syncing Web dependencies\n'
  (cd "${WEB_DIR}" && corepack yarn install)
fi

[[ -x "${SERVER_DIR}/.venv/bin/python" ]] || \
  fail "Server environment is missing; rerun without --skip-install"
[[ -x "${CONNECTOR_DIR}/.venv/bin/python" ]] || \
  fail "Connector environment is missing; rerun without --skip-install"

if [[ -n "${CONNECTOR_CONFIG_SOURCE}" ]]; then
  [[ -f "${CONNECTOR_CONFIG_SOURCE}" ]] || \
    fail "Connector config not found: ${CONNECTOR_CONFIG_SOURCE}"
  if [[ "$(cd "$(dirname "${CONNECTOR_CONFIG_SOURCE}")" && pwd)/$(basename "${CONNECTOR_CONFIG_SOURCE}")" != "${CONNECTOR_CONFIG}" ]]; then
    install -m 600 "${CONNECTOR_CONFIG_SOURCE}" "${CONNECTOR_CONFIG}"
  fi
fi

# devtools.control owns the detached Server/Web processes so the control page
# can replace either process without bringing down the rest of the stack.
printf '[setup] starting PostgreSQL, Redis, Server and Web\n'
"${ROOT_DIR}/dev-control.sh" bootstrap

printf '[setup] starting Dev Control\n'
"${ROOT_DIR}/dev-control.sh" start

if [[ "${WITH_CONNECTOR}" == true ]]; then
  [[ -f "${CONNECTOR_CONFIG}" ]] || \
    fail "Connector credential is missing; paste it at http://127.0.0.1:${CONTROL_PORT}"
  "${ROOT_DIR}/dev-control.sh" restart connector
fi

printf '\nAgents Anywhere is running on fixed local ports.\n'
printf '  Web:        http://127.0.0.1:%s\n' "${WEB_PORT}"
printf '  Server:     http://127.0.0.1:%s\n' "${SERVER_PORT}"
printf '  Dev Control:http://127.0.0.1:%s\n' "${CONTROL_PORT}"
printf '  PostgreSQL: 127.0.0.1:%s/agents_anywhere\n' "${POSTGRES_PORT}"
printf '  Redis:      127.0.0.1:%s\n' "${REDIS_PORT}"
printf '  Logs:       %s/logs\n' "${LOCAL_DIR}"
printf '  Stop all:   ./dev-control.sh down\n'
