#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="${ROOT_DIR}/server"
DESKTOP_DIR="${ROOT_DIR}/desktop-workbench"
WEB_DIR="${ROOT_DIR}/web-next"
COMPOSE_FILE="${ROOT_DIR}/docker/docker-compose.local.yml"
LOCAL_DIR="${ROOT_DIR}/.local-dev"
LOG_DIR="${LOCAL_DIR}/logs"
RUN_DIR="${LOCAL_DIR}/run"
PID_FILE="${RUN_DIR}/desktop-local-up.pid"

ENV_FILE="${AGENTS_ANYWHERE_ENV_FILE:-${ROOT_DIR}/.env.local}"
ENV_FILE_EXPLICIT=false
SKIP_INSTALL=false
ACTION=up
SHUTTING_DOWN=false

SERVICE_PIDS=()
SERVICE_NAMES=()
OUTPUT_PIDS=()
INFRA_STARTED=false

readonly SERVER_PORT=8000
readonly DESKTOP_PORT=5184
readonly WEB_PORT=5174
readonly POSTGRES_PORT=55432
readonly REDIS_PORT=56379
readonly SERVER_URL="http://127.0.0.1:${SERVER_PORT}"
readonly DESKTOP_URL="http://127.0.0.1:${DESKTOP_PORT}"
# Desktop development login opens the Web sign-in page for a local API.
readonly WEB_URL="http://127.0.0.1:${WEB_PORT}"
# Sessions left behind by the old detached launcher.
readonly LEGACY_SCREEN_SESSIONS=(aa-dev-server aa-desktop-workbench)

usage() {
  cat <<'EOF'
Start the local Agents Anywhere backend, Web sign-in, and Desktop Workbench.

Usage:
  ./desktop-local-up.sh [--env-file PATH] [--skip-install]
  ./desktop-local-up.sh down

The launcher starts Docker Desktop when needed, brings up PostgreSQL and Redis,
releases fixed ports 8000, 5174, and 5184, then runs the backend, Web, and
Desktop in the foreground. Desktop always sends API requests to the local
backend at http://127.0.0.1:8000 and signs in through the Web app at
http://127.0.0.1:5174. Press Ctrl-C to stop everything it started.

Options:
  --env-file PATH  Load additional application settings from PATH
  --skip-install   Reuse existing Server, Connector, Web, and Desktop dependencies
  -h, --help       Show this help

Commands:
  down             Stop a running launcher and release ports 8000, 5174, and 5184

Fixed ports:
  Desktop 5184, Web 5174, Server 8000, PostgreSQL 55432, Redis 56379.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

if [[ "${1:-}" == "down" ]]; then
  ACTION=down
  shift
fi

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
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

if [[ "${ACTION}" == "down" && ("${SKIP_INSTALL}" == true || "${ENV_FILE_EXPLICIT}" == true) ]]; then
  fail "down does not accept startup options"
fi

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

listener_pids() {
  lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u || true
}

port_is_free() {
  [[ -z "$(listener_pids "$1")" ]]
}

running_launcher_pid() {
  [[ -f "${PID_FILE}" ]] || return 0
  local pid command
  pid="$(<"${PID_FILE}")"
  command="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
  if [[ "${pid}" =~ ^[0-9]+$ && "${pid}" != "$$" ]] && kill -0 "${pid}" >/dev/null 2>&1 &&
    [[ "${command}" == *desktop-local-up.sh* ]]; then
    printf '%s\n' "${pid}"
  fi
}

stop_running_launcher() {
  local pid tick=0
  pid="$(running_launcher_pid)"
  [[ -n "${pid}" ]] || return 0
  printf '[stop] desktop-local-up.sh (PID %s)\n' "${pid}"
  kill -TERM "${pid}" >/dev/null 2>&1 || true
  while kill -0 "${pid}" >/dev/null 2>&1 && ((tick < 100)); do
    tick=$((tick + 1))
    sleep 0.1
  done
}

stop_legacy_screen_sessions() {
  command -v screen >/dev/null 2>&1 || return 0
  local session_name
  for session_name in "${LEGACY_SCREEN_SESSIONS[@]}"; do
    if screen -ls 2>/dev/null | grep -q "[.]${session_name}[[:space:]]"; then
      printf '[stop] screen session %s\n' "${session_name}"
      screen -S "${session_name}" -X quit >/dev/null 2>&1 || true
    fi
  done
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

release_port() {
  local port="$1"
  local label="$2"
  local current_group
  local pid
  local process_group
  local process_command
  local pid_list
  local seen_groups=" "
  local tick

  stop_docker_publishers "${port}"
  pid_list="$(listener_pids "${port}")"
  [[ -n "${pid_list}" ]] || return 0

  current_group="$(ps -p "$$" -o pgid= | tr -d ' ')"
  printf '[ports] releasing %s port %s\n' "${label}" "${port}"
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    process_command="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
    printf '  PID %s: %s\n' "${pid}" "${process_command:-unknown}"
    case "${process_command}" in
      *com.docker.backend*|*Docker.app*)
        fail "${label} port ${port} is still owned by Docker; refusing to stop Docker Desktop"
        ;;
    esac
    process_group="$(ps -p "${pid}" -o pgid= 2>/dev/null | tr -d ' ')"
    [[ -n "${process_group}" && "${process_group}" != "1" ]] || continue
    if [[ "${process_group}" == "${current_group}" ]]; then
      kill -TERM "${pid}" >/dev/null 2>&1 || true
      continue
    fi
    if [[ "${seen_groups}" != *" ${process_group} "* ]]; then
      seen_groups+="${process_group} "
      kill -TERM -- "-${process_group}" >/dev/null 2>&1 || true
    fi
  done <<<"${pid_list}"

  tick=0
  while ! port_is_free "${port}" && ((tick < 50)); do
    tick=$((tick + 1))
    sleep 0.1
  done
  port_is_free "${port}" && return 0

  printf '[ports] force releasing %s port %s\n' "${label}" "${port}"
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    process_group="$(ps -p "${pid}" -o pgid= 2>/dev/null | tr -d ' ')"
    if [[ -n "${process_group}" && "${process_group}" != "1" && "${process_group}" != "${current_group}" ]]; then
      kill -KILL -- "-${process_group}" >/dev/null 2>&1 || true
    else
      kill -KILL "${pid}" >/dev/null 2>&1 || true
    fi
  done < <(listener_pids "${port}")

  tick=0
  while ! port_is_free "${port}" && ((tick < 30)); do
    tick=$((tick + 1))
    sleep 0.1
  done
  port_is_free "${port}" || fail "could not release ${label} port ${port}"
}

stop_application_services() {
  stop_running_launcher
  stop_legacy_screen_sessions
  release_port "${DESKTOP_PORT}" "Desktop"
  release_port "${WEB_PORT}" "Web"
  release_port "${SERVER_PORT}" "Server"
}

if [[ "${ACTION}" == "down" ]]; then
  for required in docker lsof ps sort; do
    require_command "${required}"
  done
  stop_application_services
  printf 'Local Server, Web, and Desktop stopped.\n'
  exit 0
fi

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
elif [[ "${ENV_FILE_EXPLICIT}" == true ]]; then
  fail "environment file not found: ${ENV_FILE}"
fi

for required in curl docker lsof mkfifo perl pgrep ps sort tee uv; do
  require_command "${required}"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

ensure_docker() {
  if docker info >/dev/null 2>&1; then
    printf '[docker] Docker is ready\n'
    return
  fi

  printf '[docker] starting Docker\n'
  case "$(uname -s)" in
    Darwin)
      require_command open
      open -a Docker >/dev/null 2>&1 || fail "could not start Docker Desktop"
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1 && \
        systemctl --user list-unit-files docker-desktop.service >/dev/null 2>&1; then
        systemctl --user start docker-desktop.service
      else
        fail "Docker is not running; start the Docker daemon and rerun this script"
      fi
      ;;
    *)
      fail "Docker is not running; start it and rerun this script"
      ;;
  esac

  local tick=0
  while ((tick < 120)); do
    if docker info >/dev/null 2>&1; then
      printf '[docker] Docker is ready\n'
      return
    fi
    tick=$((tick + 1))
    sleep 1
  done
  fail "Docker did not become ready within 120 seconds"
}

use_desktop_node() {
  local expected_major
  local current_major=""
  local nvm_script

  expected_major="$(tr -cd '0-9' < "${DESKTOP_DIR}/.nvmrc")"
  [[ -n "${expected_major}" ]] || fail "invalid ${DESKTOP_DIR}/.nvmrc"
  if command -v node >/dev/null 2>&1; then
    current_major="$(node -p 'process.versions.node.split(".")[0]')"
  fi
  if [[ "${current_major}" != "${expected_major}" ]]; then
    nvm_script="${NVM_DIR:-${HOME}/.nvm}/nvm.sh"
    [[ -s "${nvm_script}" ]] || \
      fail "Node ${expected_major} is required and nvm was not found at ${nvm_script}"
    set +u
    # shellcheck disable=SC1090
    source "${nvm_script}"
    nvm use "${expected_major}" >/dev/null
    set -u
  fi
  current_major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "${current_major}" == "${expected_major}" ]] || \
    fail "Node ${expected_major} is required; current version is $(node --version)"
  require_command corepack
  printf '[node] using %s\n' "$(node --version)"
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
  if [[ -f "${PID_FILE}" ]] && [[ "$(<"${PID_FILE}")" == "$$" ]]; then
    rm -f "${PID_FILE}"
  fi
  if [[ "${INFRA_STARTED}" == true ]] && docker info >/dev/null 2>&1; then
    AGENTS_ANYWHERE_POSTGRES_PORT="${POSTGRES_PORT}" \
    AGENTS_ANYWHERE_REDIS_PORT="${REDIS_PORT}" \
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
  local attempts="$3"
  local attempt=0
  while ((attempt < attempts)); do
    check_services || fail "${name} stopped during startup"
    if curl --fail --silent --max-time 1 --output /dev/null "${url}"; then
      printf '%s[ready]%s %-9s %s\n' "${GREEN}" "${RESET}" "${name}" "${url}"
      return
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  fail "${name} did not become ready: ${url}"
}

ensure_docker
use_desktop_node

if [[ "${SKIP_INSTALL}" != true ]]; then
  printf '%s[setup]%s Syncing Server dependencies...\n' "${CYAN}" "${RESET}"
  (cd "${SERVER_DIR}" && UV_NO_PROGRESS=1 uv sync)
  printf '%s[setup]%s Syncing Connector dependencies...\n' "${CYAN}" "${RESET}"
  (cd "${ROOT_DIR}/connector" && UV_NO_PROGRESS=1 uv sync)
  printf '%s[setup]%s Syncing Web dependencies...\n' "${CYAN}" "${RESET}"
  (cd "${WEB_DIR}" && corepack yarn install)
  printf '%s[setup]%s Syncing Desktop dependencies...\n' "${CYAN}" "${RESET}"
  (cd "${DESKTOP_DIR}" && corepack yarn install)
fi

[[ -x "${SERVER_DIR}/.venv/bin/python" ]] || \
  fail "Server environment is missing; rerun without --skip-install"
[[ -x "${SERVER_DIR}/.venv/bin/uvicorn" ]] || \
  fail "uvicorn is missing; rerun without --skip-install"
[[ -d "${DESKTOP_DIR}/node_modules" ]] || \
  fail "Desktop dependencies are missing; rerun without --skip-install"
[[ -d "${WEB_DIR}/node_modules" ]] || \
  fail "Web dependencies are missing; rerun without --skip-install"

mkdir -p "${LOG_DIR}" "${RUN_DIR}" "${LOCAL_DIR}/files"
chmod 700 "${LOCAL_DIR}"

stop_application_services

printf '%s\n' "$$" >"${PID_FILE}"
chmod 600 "${PID_FILE}"
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agents-anywhere-desktop.XXXXXX")"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '%s[setup]%s Starting PostgreSQL and Redis...\n' "${CYAN}" "${RESET}"
AGENTS_ANYWHERE_POSTGRES_PORT="${POSTGRES_PORT}" \
AGENTS_ANYWHERE_REDIS_PORT="${REDIS_PORT}" \
  docker compose -f "${COMPOSE_FILE}" up -d --wait
INFRA_STARTED=true

readonly DB_URL="postgresql+asyncpg://agents_anywhere:agents_anywhere_dev_password@127.0.0.1:${POSTGRES_PORT}/agents_anywhere"
readonly REDIS_URL="redis://127.0.0.1:${REDIS_PORT}/0"
readonly SERVER_CORS_ORIGINS="${DESKTOP_URL},http://localhost:${DESKTOP_PORT},${WEB_URL},http://localhost:${WEB_PORT}"

printf '%s[setup]%s Applying database migrations...\n' "${CYAN}" "${RESET}"
(
  cd "${SERVER_DIR}"
  env \
    AGENT_SERVER_DB_URL="${DB_URL}" \
    AGENT_SERVER_REDIS_URL="${REDIS_URL}" \
    AGENT_SERVER_FILES_LOCAL_ROOT="${LOCAL_DIR}/files" \
    AGENT_SERVER_PUBLIC_ORIGIN="${WEB_URL}" \
    AGENT_SERVER_CORS_ORIGINS="${SERVER_CORS_ORIGINS}" \
    "${SERVER_DIR}/.venv/bin/python" -m agent_server.infra.db.migrations upgrade
)

start_service server "${CYAN}" "${SERVER_DIR}" \
  env \
  AGENT_SERVER_DB_URL="${DB_URL}" \
  AGENT_SERVER_REDIS_URL="${REDIS_URL}" \
  AGENT_SERVER_FILES_LOCAL_ROOT="${LOCAL_DIR}/files" \
  AGENT_SERVER_PUBLIC_ORIGIN="${WEB_URL}" \
  AGENT_SERVER_CORS_ORIGINS="${SERVER_CORS_ORIGINS}" \
  LOGURU_LEVEL="${LOGURU_LEVEL:-INFO}" \
  "${SERVER_DIR}/.venv/bin/uvicorn" \
  agent_server.app:create_app \
  --factory \
  --host 127.0.0.1 \
  --port "${SERVER_PORT}" \
  --no-access-log
wait_for_url server "${SERVER_URL}/api/v2/health" 60

start_service web "${YELLOW}" "${WEB_DIR}" \
  env AGENTS_ANYWHERE_API="${SERVER_URL}" \
  corepack yarn exec next dev --hostname 127.0.0.1 --port "${WEB_PORT}"
wait_for_url web "${WEB_URL}/" 120

start_service desktop "${GREEN}" "${DESKTOP_DIR}" \
  env \
  WORKBENCH_WEB_PORT="${DESKTOP_PORT}" \
  WORKBENCH_API_ORIGIN="${SERVER_URL}" \
  WORKBENCH_API_NAMESPACE=/api/v2 \
  WORKBENCH_OAUTH_WEB_ORIGIN="${WEB_URL}" \
  AGENTS_ANYWHERE_API="${SERVER_URL}" \
  AGENTS_ANYWHERE_API_NAMESPACE=/api/v2 \
  corepack yarn dev
wait_for_url desktop "${DESKTOP_URL}" 120
wait_for_url "API proxy" "${DESKTOP_URL}/api/v2/health" 30

proxy_server="$(curl --silent --show-error --max-time 5 --dump-header - --output /dev/null \
  "${DESKTOP_URL}/api/v2/health" | awk 'tolower($1) == "server:" {gsub("\\r", "", $2); print tolower($2); exit}')"
[[ "${proxy_server}" == "uvicorn" ]] || \
  fail "Desktop API proxy did not reach the local uvicorn backend (server=${proxy_server:-missing})"

printf '\n%s[local]%s Desktop stack is ready.\n' "${GREEN}" "${RESET}"
printf '  Desktop:    %s\n' "${DESKTOP_URL}"
printf '  Web login:  %s\n' "${WEB_URL}"
printf '  Server:     %s\n' "${SERVER_URL}"
printf '  API proxy:  %s/api/v2 -> %s/api/v2\n' "${DESKTOP_URL}" "${SERVER_URL}"
printf '  PostgreSQL: 127.0.0.1:%s/agents_anywhere\n' "${POSTGRES_PORT}"
printf '  Redis:      127.0.0.1:%s\n' "${REDIS_PORT}"
printf '  Logs:       %s\n' "${LOG_DIR}"
printf '  Stop:       Ctrl-C\n\n'

while true; do
  check_services || fail "a service stopped unexpectedly"
  sleep 1
done
