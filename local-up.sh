#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="${ROOT_DIR}/server"
WEB_DIR="${ROOT_DIR}/web-next"
CONNECTOR_DIR="${ROOT_DIR}/connector"

ENV_FILE="${AGENTS_ANYWHERE_ENV_FILE:-${ROOT_DIR}/.env.local}"
ENV_FILE_EXPLICIT=false
CONNECTOR_CONFIG_EXPLICIT=false
SKIP_INSTALL=false
WITH_CONNECTOR=false
SERVER_RELOAD=true
SHUTTING_DOWN=false
DEPENDENCIES_STARTED=false

SERVICE_PIDS=()
SERVICE_NAMES=()
OUTPUT_PIDS=()

usage() {
  cat <<'EOF'
Start the local Agents Anywhere source stack.

Usage:
  ./local-up.sh [options]

Options:
  --env-file PATH       Load environment overrides from PATH
  --skip-install        Skip uv sync and yarn install
  --with-connector      Also start the local Connector
  --connector-config P  Connector config used with --with-connector
  --no-reload           Disable uvicorn source reload
  -h, --help            Show this help

The stack starts PostgreSQL and Redis with Docker Compose, then runs the Server
and Web from source. PostgreSQL data persists in a named volume. An existing
.env.local is loaded automatically. Connector startup is opt-in because its
saved config may point at another Server.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

CONNECTOR_CONFIG="${AGENT_CONNECTOR_CONFIG:-${AGENT_CONNECTOR_DATA_DIR:-${HOME}/.agents-anywhere}/connector.json}"

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
      CONNECTOR_CONFIG="$2"
      CONNECTOR_CONFIG_EXPLICIT=true
      shift 2
      ;;
    --no-reload)
      SERVER_RELOAD=false
      shift
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

if [[ "${CONNECTOR_CONFIG_EXPLICIT}" != true ]]; then
  CONNECTOR_CONFIG="${AGENT_CONNECTOR_CONFIG:-${AGENT_CONNECTOR_DATA_DIR:-${HOME}/.agents-anywhere}/connector.json}"
fi

SERVER_HOST="${SERVER_HOST:-127.0.0.1}"
SERVER_PORT="${SERVER_PORT:-8000}"
WEB_HOST="${WEB_HOST:-127.0.0.1}"
WEB_PORT="${WEB_PORT:-5174}"
LOCAL_DIR="${AGENTS_ANYWHERE_LOCAL_DIR:-${ROOT_DIR}/.local-dev}"
LOG_DIR="${LOCAL_DIR}/logs"
AGENT_SERVER_FILES_LOCAL_ROOT="${AGENT_SERVER_FILES_LOCAL_ROOT:-${LOCAL_DIR}/files}"
POSTGRES_PORT="${AGENTS_ANYWHERE_POSTGRES_PORT:-55432}"
REDIS_PORT="${AGENTS_ANYWHERE_REDIS_PORT:-56379}"
COMPOSE_FILE="${ROOT_DIR}/docker/docker-compose.local.yml"
AGENT_SERVER_DB_URL="postgresql+asyncpg://agents_anywhere:agents_anywhere_dev_password@127.0.0.1:${POSTGRES_PORT}/agents_anywhere"
AGENT_SERVER_REDIS_URL="redis://127.0.0.1:${REDIS_PORT}/0"
LOCAL_SERVER_URL="http://${SERVER_HOST}:${SERVER_PORT}"
AGENTS_ANYWHERE_API="${AGENTS_ANYWHERE_API:-${LOCAL_SERVER_URL}}"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  RESET=$'\033[0m'
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  CYAN=$'\033[36m'
else
  RESET=""
  RED=""
  GREEN=""
  YELLOW=""
  CYAN=""
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

assert_port_available() {
  local port="$1"
  local name="$2"
  if nc -z 127.0.0.1 "${port}" >/dev/null 2>&1; then
    fail "port ${port} is already in use (${name})"
  fi
}

strip_ansi() {
  perl -pe \
    'BEGIN { $| = 1 } s/\e\[[0-?]*[ -\/]*[@-~]//g; s/\e\][^\a]*(?:\a|\e\\)//g'
}

prefix_stream() {
  local label="$1"
  local color="$2"
  local line
  while IFS= read -r line || [[ -n "${line}" ]]; do
    printf '%s[%s]%s %s\n' "${color}" "${label}" "${RESET}" "${line}"
  done
}

start_service() {
  local name="$1"
  local color="$2"
  local directory="$3"
  shift 3

  local fifo="${RUNTIME_DIR}/${name}.fifo"
  local log_file="${LOG_DIR}/${name}.log"
  mkfifo "${fifo}"
  : >"${log_file}"

  (
    tee >(strip_ansi >"${log_file}") <"${fifo}" |
      prefix_stream "${name}" "${color}"
  ) &
  OUTPUT_PIDS+=("$!")

  (
    cd "${directory}"
    exec "$@"
  ) >"${fifo}" 2>&1 &
  SERVICE_PIDS+=("$!")
  SERVICE_NAMES+=("${name}")
}

stop_process_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "${pid}" 2>/dev/null || true); do
    stop_process_tree "${child}"
  done
  kill -TERM "${pid}" >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?
  if [[ "${SHUTTING_DOWN}" == true ]]; then
    return
  fi
  SHUTTING_DOWN=true
  trap - EXIT INT TERM

  printf '\n%s[local]%s Stopping services...\n' "${YELLOW}" "${RESET}"
  local pid
  for pid in "${SERVICE_PIDS[@]-}"; do
    [[ -n "${pid}" ]] && stop_process_tree "${pid}"
  done
  for pid in "${SERVICE_PIDS[@]-}"; do
    [[ -n "${pid}" ]] && wait "${pid}" >/dev/null 2>&1 || true
  done
  for pid in "${OUTPUT_PIDS[@]-}"; do
    [[ -z "${pid}" ]] && continue
    kill -TERM "${pid}" >/dev/null 2>&1 || true
    wait "${pid}" >/dev/null 2>&1 || true
  done
  if [[ "${DEPENDENCIES_STARTED}" == true ]]; then
    docker compose -f "${COMPOSE_FILE}" down >/dev/null 2>&1 || true
  fi
  if [[ -n "${RUNTIME_DIR:-}" && -d "${RUNTIME_DIR}" ]]; then
    find "${RUNTIME_DIR}" -type p -delete
    rmdir "${RUNTIME_DIR}" >/dev/null 2>&1 || true
  fi
  exit "${status}"
}

check_services() {
  local index
  for ((index = 0; index < ${#SERVICE_PIDS[@]}; index++)); do
    if ! kill -0 "${SERVICE_PIDS[$index]}" >/dev/null 2>&1; then
      local name="${SERVICE_NAMES[$index]}"
      printf '%s[local]%s %s stopped unexpectedly. Last log lines:\n' \
        "${RED}" "${RESET}" "${name}" >&2
      tail -n 40 "${LOG_DIR}/${name}.log" >&2 || true
      return 1
    fi
  done
}

wait_for_url() {
  local name="$1"
  local url="$2"
  local attempt=0
  while ((attempt < 60)); do
    check_services || fail "${name} stopped during startup"
    if curl --fail --silent --output /dev/null "${url}"; then
      printf '%s[ready]%s %-9s %s\n' "${GREEN}" "${RESET}" "${name}" "${url}"
      return
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  fail "${name} did not become ready: ${url}"
}

for command in corepack curl docker mkfifo nc perl pgrep tee uv; do
  require_command "${command}"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

assert_port_available "${SERVER_PORT}" "server"
assert_port_available "${WEB_PORT}" "web"
docker compose -f "${COMPOSE_FILE}" down >/dev/null 2>&1 || true
assert_port_available "${POSTGRES_PORT}" "postgres"
assert_port_available "${REDIS_PORT}" "redis"

if [[ "${WITH_CONNECTOR}" == true ]]; then
  if [[ -z "${AGENT_CONNECTOR_ID:-}" || -z "${AGENT_CONNECTOR_TOKEN:-}" ]]; then
    [[ -f "${CONNECTOR_CONFIG}" ]] || fail \
      "--with-connector requires AGENT_CONNECTOR_ID and AGENT_CONNECTOR_TOKEN, or config ${CONNECTOR_CONFIG}"
  fi
fi

mkdir -p "${LOG_DIR}" "${AGENT_SERVER_FILES_LOCAL_ROOT}"
chmod 700 "${LOCAL_DIR}"
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agents-anywhere-local.XXXXXX")"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '%s[setup]%s Starting PostgreSQL and Redis...\n' "${CYAN}" "${RESET}"
DEPENDENCIES_STARTED=true
AGENTS_ANYWHERE_POSTGRES_PORT="${POSTGRES_PORT}" \
  AGENTS_ANYWHERE_REDIS_PORT="${REDIS_PORT}" \
  docker compose -f "${COMPOSE_FILE}" up -d --wait

if [[ "${SKIP_INSTALL}" != true ]]; then
  printf '%s[setup]%s Syncing Server dependencies...\n' "${CYAN}" "${RESET}"
  (cd "${SERVER_DIR}" && UV_NO_PROGRESS=1 uv sync)

  printf '%s[setup]%s Syncing Web dependencies...\n' "${CYAN}" "${RESET}"
  (cd "${WEB_DIR}" && corepack yarn install)

  if [[ "${WITH_CONNECTOR}" == true ]]; then
    printf '%s[setup]%s Syncing Connector dependencies...\n' "${CYAN}" "${RESET}"
    (cd "${CONNECTOR_DIR}" && UV_NO_PROGRESS=1 uv sync)
  fi
fi

printf '%s[setup]%s Applying local database migrations...\n' "${CYAN}" "${RESET}"
(
  cd "${SERVER_DIR}"
  env \
    AGENT_SERVER_DB_BACKEND=postgres \
    AGENT_SERVER_DB_URL="${AGENT_SERVER_DB_URL}" \
    uv run python -m agent_server.infra.db.migrations upgrade
)

SERVER_COMMAND=(
  env
  "AGENT_SERVER_DB_BACKEND=postgres"
  "AGENT_SERVER_DB_URL=${AGENT_SERVER_DB_URL}"
  "AGENT_SERVER_REDIS_URL=${AGENT_SERVER_REDIS_URL}"
  "AGENT_SERVER_FILES_LOCAL_ROOT=${AGENT_SERVER_FILES_LOCAL_ROOT}"
  "AGENT_SERVER_PUBLIC_ORIGIN=http://${WEB_HOST}:${WEB_PORT}"
  "AGENT_SERVER_CORS_ORIGINS=http://${WEB_HOST}:${WEB_PORT},http://localhost:${WEB_PORT}"
  uv run uvicorn agent_server.app:create_app
  --factory
  --host "${SERVER_HOST}"
  --port "${SERVER_PORT}"
)
if [[ "${SERVER_RELOAD}" == true ]]; then
  SERVER_COMMAND+=(--reload)
fi

start_service server "${CYAN}" "${SERVER_DIR}" "${SERVER_COMMAND[@]}"
start_service web "${GREEN}" "${WEB_DIR}" \
  env "AGENTS_ANYWHERE_API=${AGENTS_ANYWHERE_API}" \
  corepack yarn exec next dev --hostname "${WEB_HOST}" --port "${WEB_PORT}"

if [[ "${WITH_CONNECTOR}" == true ]]; then
  CONNECTOR_COMMAND=(uv run anywhere-cli start --config "${CONNECTOR_CONFIG}")
  if [[ -n "${AGENT_CONNECTOR_ID:-}" && -n "${AGENT_CONNECTOR_TOKEN:-}" ]]; then
    CONNECTOR_COMMAND+=(
      --server-url "${LOCAL_SERVER_URL}"
      --connector-id "${AGENT_CONNECTOR_ID}"
      --connector-token "${AGENT_CONNECTOR_TOKEN}"
    )
  fi
  start_service connector "${YELLOW}" "${CONNECTOR_DIR}" \
    "${CONNECTOR_COMMAND[@]}"
fi

wait_for_url server "${LOCAL_SERVER_URL}/api/v2/health"
wait_for_url web "http://${WEB_HOST}:${WEB_PORT}/"

printf '\n%s[local]%s Stack is ready.\n' "${GREEN}" "${RESET}"
printf '  Web:       http://%s:%s\n' "${WEB_HOST}" "${WEB_PORT}"
printf '  Server:    %s\n' "${AGENTS_ANYWHERE_API}"
printf '  PostgreSQL: 127.0.0.1:%s/agents_anywhere\n' "${POSTGRES_PORT}"
printf '  Redis:      127.0.0.1:%s\n' "${REDIS_PORT}"
printf '  Logs:      %s\n' "${LOG_DIR}"
if [[ "${WITH_CONNECTOR}" == true ]]; then
  printf '  Connector: enabled\n'
fi
printf '  Stop:      Ctrl-C\n\n'

while true; do
  check_services || fail "a service stopped unexpectedly"
  sleep 1
done
