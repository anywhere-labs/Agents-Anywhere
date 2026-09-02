#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="${ROOT_DIR}/server"
WEB_DIR="${ROOT_DIR}/web-next"
CONNECTOR_DIR="${ROOT_DIR}/connector"
COMPOSE_FILE="${ROOT_DIR}/docker/docker-compose.local.yml"

ENV_FILE="${AGENTS_ANYWHERE_ENV_FILE:-${ROOT_DIR}/.env.local}"
ENV_FILE_EXPLICIT=false
CONNECTOR_CONFIG_EXPLICIT=false
LISTEN_HOST_CLI=""
SKIP_INSTALL=false
WITH_CONNECTOR=false
SERVER_RELOAD=true
RESET_DATA=false
SHUTTING_DOWN=false

SERVICE_PIDS=()
SERVICE_NAMES=()
OUTPUT_PIDS=()
INFRA_STARTED=false

usage() {
  cat <<'EOF'
Start the local Agents Anywhere source stack.

Usage:
  ./local-up.sh [options]

Options:
  --env-file PATH       Load environment overrides from PATH
  --listen [HOST]       Bind Server and Web (HOST defaults to 0.0.0.0)
  --public              Alias for --listen 0.0.0.0
  --skip-install        Skip uv sync and yarn install
  --with-connector      Also start the local Connector
  --connector-config P  Connector config used with --with-connector
  --no-reload           Disable uvicorn source reload
  --reset-data          Remove the local PostgreSQL and Redis volumes first
  -h, --help            Show this help

The default stack uses Docker PostgreSQL and Redis. An existing .env.local is
loaded automatically. Connector startup is opt-in because its saved config may
point at another Server.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

CONNECTOR_CONFIG="${AGENT_CONNECTOR_CONFIG:-${HOME}/.agents-anywhere/connector.json}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ $# -ge 2 ]] || fail "--env-file requires a path"
      ENV_FILE="$2"
      ENV_FILE_EXPLICIT=true
      shift 2
      ;;
    --listen)
      LISTEN_HOST_CLI="0.0.0.0"
      if [[ $# -ge 2 && "$2" != -* ]]; then
        LISTEN_HOST_CLI="$2"
        shift 2
      else
        shift
      fi
      ;;
    --public)
      LISTEN_HOST_CLI="0.0.0.0"
      shift
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
    --reset-data)
      RESET_DATA=true
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
  CONNECTOR_CONFIG="${AGENT_CONNECTOR_CONFIG:-${HOME}/.agents-anywhere/connector.json}"
fi

LISTEN_HOST="${AGENTS_ANYWHERE_LISTEN_HOST:-127.0.0.1}"
if [[ -n "${LISTEN_HOST_CLI}" ]]; then
  LISTEN_HOST="${LISTEN_HOST_CLI}"
  SERVER_HOST="${LISTEN_HOST}"
  WEB_HOST="${LISTEN_HOST}"
fi
SERVER_HOST="${SERVER_HOST:-${LISTEN_HOST}}"
SERVER_PORT="${SERVER_PORT:-8000}"
WEB_HOST="${WEB_HOST:-${LISTEN_HOST}}"
WEB_PORT="${WEB_PORT:-5174}"
LOCAL_ACCESS_HOST="127.0.0.1"
LOCAL_DIR="${AGENTS_ANYWHERE_LOCAL_DIR:-${ROOT_DIR}/.local-dev}"
LOG_DIR="${LOCAL_DIR}/logs"
RUN_DIR="${LOCAL_DIR}/run"
LOCAL_UP_PID_FILE="${RUN_DIR}/local-up.pid"
AGENT_SERVER_FILES_LOCAL_ROOT="${AGENT_SERVER_FILES_LOCAL_ROOT:-${LOCAL_DIR}/files}"
POSTGRES_PORT="${AGENTS_ANYWHERE_POSTGRES_PORT:-55432}"
REDIS_PORT="${AGENTS_ANYWHERE_REDIS_PORT:-56379}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-agents_anywhere_dev_password}"
AGENT_SERVER_DB_URL="${AGENT_SERVER_DB_URL:-postgresql+asyncpg://agents_anywhere:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/agents_anywhere}"
AGENT_SERVER_REDIS_URL="${AGENT_SERVER_REDIS_URL:-redis://127.0.0.1:${REDIS_PORT}/0}"
LOCAL_SERVER_URL="http://${LOCAL_ACCESS_HOST}:${SERVER_PORT}"
LOCAL_WEB_URL="http://${LOCAL_ACCESS_HOST}:${WEB_PORT}"
AGENTS_ANYWHERE_API="${AGENTS_ANYWHERE_API:-${LOCAL_SERVER_URL}}"
SERVER_PUBLIC_ORIGIN="${AGENT_SERVER_PUBLIC_ORIGIN:-${LOCAL_WEB_URL}}"
SERVER_CORS_ORIGINS="${AGENT_SERVER_CORS_ORIGINS:-${LOCAL_WEB_URL},http://localhost:${WEB_PORT}}"

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

discover_lan_ipv4() {
  local platform
  platform="$(uname -s)"

  if [[ "${platform}" == "Darwin" ]] &&
    command -v route >/dev/null 2>&1 && command -v ipconfig >/dev/null 2>&1; then
    local interface
    interface="$(route -n get default 2>/dev/null | sed -n \
      '/^[[:space:]]*interface: /{s/^[[:space:]]*interface: //;p;q;}')"
    if [[ -n "${interface}" ]]; then
      ipconfig getifaddr "${interface}" 2>/dev/null || true
      return 0
    fi
  fi

  if command -v ip >/dev/null 2>&1; then
    local previous=""
    local token
    for token in $(ip -4 route get 1.1.1.1 2>/dev/null); do
      if [[ "${previous}" == "src" ]]; then
        printf '%s\n' "${token}"
        return 0
      fi
      previous="${token}"
    done
  fi

  if command -v hostname >/dev/null 2>&1; then
    local address
    for address in $(hostname -I 2>/dev/null || true); do
      if [[ "${address}" != 127.* && "${address}" != *:* ]]; then
        printf '%s\n' "${address}"
        return 0
      fi
    done
  fi
  return 0
}

reset_local_data() {
  if [[ "${RESET_DATA}" != true ]]; then
    return 0
  fi

  if [[ -f "${LOCAL_UP_PID_FILE}" ]]; then
    local pid command
    pid="$(<"${LOCAL_UP_PID_FILE}")"
    command="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
    if [[ "${pid}" =~ ^[0-9]+$ ]] && kill -0 "${pid}" >/dev/null 2>&1 &&
      [[ "${command}" == *local-up.sh* ]]; then
      fail "another local-up.sh is already running (PID ${pid}); stop it with Ctrl-C first"
    fi
    rm -f "${LOCAL_UP_PID_FILE}"
  fi

  printf '%s[setup]%s Removing local PostgreSQL and Redis data volumes...\n' \
    "${YELLOW}" "${RESET}"
  docker compose -f "${COMPOSE_FILE}" down --remove-orphans --volumes
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
  if [[ -n "${RUNTIME_DIR:-}" && -d "${RUNTIME_DIR}" ]]; then
    find "${RUNTIME_DIR}" -type p -delete
    rmdir "${RUNTIME_DIR}" >/dev/null 2>&1 || true
  fi
  if [[ -f "${LOCAL_UP_PID_FILE}" ]] &&
    [[ "$(<"${LOCAL_UP_PID_FILE}")" == "$$" ]]; then
    rm -f "${LOCAL_UP_PID_FILE}"
  fi
  if [[ "${INFRA_STARTED}" == true ]] && docker info >/dev/null 2>&1; then
    docker compose -f "${COMPOSE_FILE}" down --remove-orphans >/dev/null 2>&1 || true
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

for command in corepack curl docker mkfifo nc perl pgrep ps tee uname uv; do
  require_command "${command}"
done

docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
docker info >/dev/null 2>&1 || fail "Docker is not running. Start Docker, then run ./local-up.sh again"

reset_local_data

assert_port_available "${SERVER_PORT}" "server"
assert_port_available "${WEB_PORT}" "web"
assert_port_available "${POSTGRES_PORT}" "PostgreSQL"
assert_port_available "${REDIS_PORT}" "Redis"

if [[ "${WITH_CONNECTOR}" == true ]]; then
  if [[ -z "${AGENT_CONNECTOR_ID:-}" || -z "${AGENT_CONNECTOR_TOKEN:-}" ]]; then
    [[ -f "${CONNECTOR_CONFIG}" ]] || fail \
      "--with-connector requires AGENT_CONNECTOR_ID and AGENT_CONNECTOR_TOKEN, or config ${CONNECTOR_CONFIG}"
  fi
fi

mkdir -p "${LOG_DIR}" "${RUN_DIR}" "${AGENT_SERVER_FILES_LOCAL_ROOT}"
chmod 700 "${LOCAL_DIR}"
printf '%s\n' "$$" >"${LOCAL_UP_PID_FILE}"
chmod 600 "${LOCAL_UP_PID_FILE}"
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agents-anywhere-local.XXXXXX")"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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

printf '%s[setup]%s Starting PostgreSQL and Redis...\n' "${CYAN}" "${RESET}"
AGENTS_ANYWHERE_POSTGRES_PORT="${POSTGRES_PORT}" \
AGENTS_ANYWHERE_REDIS_PORT="${REDIS_PORT}" \
POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
  docker compose -f "${COMPOSE_FILE}" up -d --wait
INFRA_STARTED=true

printf '%s[setup]%s Applying v2.24 database migrations...\n' "${CYAN}" "${RESET}"
(
  cd "${SERVER_DIR}"
  env \
    AGENT_SERVER_DB_BACKEND=postgres \
    AGENT_SERVER_DB_URL="${AGENT_SERVER_DB_URL}" \
    AGENT_SERVER_REDIS_URL="${AGENT_SERVER_REDIS_URL}" \
    uv run python -m agent_server.infra.db.migrations upgrade
)

SERVER_COMMAND=(
  env
  "AGENT_SERVER_DB_BACKEND=postgres"
  "AGENT_SERVER_DB_URL=${AGENT_SERVER_DB_URL}"
  "AGENT_SERVER_REDIS_URL=${AGENT_SERVER_REDIS_URL}"
  "AGENT_SERVER_FILES_LOCAL_ROOT=${AGENT_SERVER_FILES_LOCAL_ROOT}"
  "AGENT_SERVER_PUBLIC_ORIGIN=${SERVER_PUBLIC_ORIGIN}"
  "AGENT_SERVER_CORS_ORIGINS=${SERVER_CORS_ORIGINS}"
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
wait_for_url web "${LOCAL_WEB_URL}/"

printf '\n%s[local]%s Stack is ready.\n' "${GREEN}" "${RESET}"
printf '  Web:       %s\n' "${LOCAL_WEB_URL}"
printf '  Server:    %s\n' "${AGENTS_ANYWHERE_API}"
printf '  Listen:    server=%s:%s web=%s:%s\n' \
  "${SERVER_HOST}" "${SERVER_PORT}" "${WEB_HOST}" "${WEB_PORT}"
if [[ "${SERVER_HOST}" != "127.0.0.1" || "${WEB_HOST}" != "127.0.0.1" ]]; then
  LAN_HOST="${AGENTS_ANYWHERE_LAN_HOST:-$(discover_lan_ipv4)}"
  if [[ -n "${LAN_HOST}" ]]; then
    [[ "${WEB_HOST}" != "127.0.0.1" ]] &&
      printf '  LAN Web:   http://%s:%s\n' "${LAN_HOST}" "${WEB_PORT}"
    [[ "${SERVER_HOST}" != "127.0.0.1" ]] &&
      printf '  LAN Server: http://%s:%s\n' "${LAN_HOST}" "${SERVER_PORT}"
  else
    printf '  LAN:       address unavailable (set AGENTS_ANYWHERE_LAN_HOST)\n'
  fi
fi
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
