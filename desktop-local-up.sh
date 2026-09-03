#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="${ROOT_DIR}/server"
DESKTOP_DIR="${ROOT_DIR}/desktop-workbench"
COMPOSE_FILE="${ROOT_DIR}/docker/docker-compose.local.yml"
LOCAL_DIR="${ROOT_DIR}/.local-dev"
LOG_DIR="${LOCAL_DIR}/logs"
SERVER_LOG="${LOG_DIR}/server.log"
DESKTOP_LOG="${LOG_DIR}/desktop-workbench.log"

ENV_FILE="${AGENTS_ANYWHERE_ENV_FILE:-${ROOT_DIR}/.env.local}"
ENV_FILE_EXPLICIT=false
SKIP_INSTALL=false
ACTION=up

readonly SERVER_PORT=8000
readonly DESKTOP_PORT=5184
readonly POSTGRES_PORT=55432
readonly REDIS_PORT=56379
readonly SERVER_SESSION="aa-dev-server"
readonly DESKTOP_SESSION="aa-desktop-workbench"
readonly SERVER_URL="http://127.0.0.1:${SERVER_PORT}"
readonly DESKTOP_URL="http://127.0.0.1:${DESKTOP_PORT}"

usage() {
  cat <<'EOF'
Start the local Agents Anywhere backend and Desktop Workbench.

Usage:
  ./desktop-local-up.sh [--env-file PATH] [--skip-install]
  ./desktop-local-up.sh down

The launcher starts Docker Desktop when needed, brings up PostgreSQL and Redis,
releases fixed ports 8000 and 5184, then starts the backend and Desktop. Desktop
always sends API requests to the local backend at http://127.0.0.1:8000.

Options:
  --env-file PATH  Load additional application settings from PATH
  --skip-install   Reuse existing Server, Connector, and Desktop dependencies
  -h, --help       Show this help

Fixed ports:
  Desktop 5184, Server 8000, PostgreSQL 55432, Redis 56379.
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

listener_pids() {
  lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u || true
}

port_is_free() {
  [[ -z "$(listener_pids "$1")" ]]
}

screen_session_exists() {
  screen -ls 2>/dev/null | grep -q "[.]$1[[:space:]]"
}

stop_screen_session() {
  local session_name="$1"
  if screen_session_exists "${session_name}"; then
    printf '[stop] screen session %s\n' "${session_name}"
    screen -S "${session_name}" -X quit >/dev/null 2>&1 || true
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
  stop_screen_session "${DESKTOP_SESSION}"
  stop_screen_session "${SERVER_SESSION}"
  release_port "${DESKTOP_PORT}" "Desktop"
  release_port "${SERVER_PORT}" "Server"
}

if [[ "${ACTION}" == "down" ]]; then
  for required in docker grep lsof ps screen sort; do
    require_command "${required}"
  done
  stop_application_services
  printf 'Local Server and Desktop stopped. PostgreSQL and Redis remain running.\n'
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

for required in curl docker grep lsof ps screen sort uv; do
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

start_screen_session() {
  local session_name="$1"
  local working_dir="$2"
  local log_path="$3"
  shift 3
  local launch_line
  local quoted_arg

  printf -v launch_line 'cd %q && exec' "${working_dir}"
  for quoted_arg in "$@"; do
    printf -v quoted_arg '%q' "${quoted_arg}"
    launch_line+=" ${quoted_arg}"
  done
  printf -v quoted_arg '%q' "${log_path}"
  launch_line+=" >> ${quoted_arg} 2>&1"
  : >"${log_path}"
  screen -dmS "${session_name}" bash -c "${launch_line}"
}

wait_for_url() {
  local url="$1"
  local label="$2"
  local attempts="$3"
  local tick=0
  while ((tick < attempts)); do
    if curl --fail --silent --show-error --max-time 1 --output /dev/null "${url}"; then
      return
    fi
    tick=$((tick + 1))
    sleep 0.5
  done
  fail "${label} did not become ready at ${url}"
}

ensure_docker
use_desktop_node

if [[ "${SKIP_INSTALL}" != true ]]; then
  printf '[setup] syncing Server dependencies\n'
  (cd "${SERVER_DIR}" && UV_NO_PROGRESS=1 uv sync)
  printf '[setup] syncing Connector dependencies\n'
  (cd "${ROOT_DIR}/connector" && UV_NO_PROGRESS=1 uv sync)
  printf '[setup] syncing Desktop dependencies\n'
  (cd "${DESKTOP_DIR}" && corepack yarn install)
fi

[[ -x "${SERVER_DIR}/.venv/bin/python" ]] || \
  fail "Server environment is missing; rerun without --skip-install"
[[ -x "${SERVER_DIR}/.venv/bin/uvicorn" ]] || \
  fail "uvicorn is missing; rerun without --skip-install"
[[ -d "${DESKTOP_DIR}/node_modules" ]] || \
  fail "Desktop dependencies are missing; rerun without --skip-install"

mkdir -p "${LOG_DIR}" "${LOCAL_DIR}/files"
chmod 700 "${LOCAL_DIR}"

stop_application_services

printf '[docker] starting PostgreSQL and Redis\n'
AGENTS_ANYWHERE_POSTGRES_PORT="${POSTGRES_PORT}" \
AGENTS_ANYWHERE_REDIS_PORT="${REDIS_PORT}" \
  docker compose -f "${COMPOSE_FILE}" up -d --wait

readonly DB_URL="postgresql+asyncpg://agents_anywhere:agents_anywhere_dev_password@127.0.0.1:${POSTGRES_PORT}/agents_anywhere"
readonly REDIS_URL="redis://127.0.0.1:${REDIS_PORT}/0"

printf '[server] running database migrations\n'
env \
  AGENT_SERVER_DB_BACKEND=postgres \
  AGENT_SERVER_DB_URL="${DB_URL}" \
  AGENT_SERVER_REDIS_URL="${REDIS_URL}" \
  AGENT_SERVER_FILES_LOCAL_ROOT="${LOCAL_DIR}/files" \
  AGENT_SERVER_PUBLIC_ORIGIN="${DESKTOP_URL}" \
  AGENT_SERVER_CORS_ORIGINS="${DESKTOP_URL},http://localhost:${DESKTOP_PORT}" \
  "${SERVER_DIR}/.venv/bin/python" -m agent_server.infra.db.migrations upgrade

printf '[server] starting on %s\n' "${SERVER_URL}"
start_screen_session \
  "${SERVER_SESSION}" \
  "${SERVER_DIR}" \
  "${SERVER_LOG}" \
  env \
  AGENT_SERVER_DB_BACKEND=postgres \
  AGENT_SERVER_DB_URL="${DB_URL}" \
  AGENT_SERVER_REDIS_URL="${REDIS_URL}" \
  AGENT_SERVER_FILES_LOCAL_ROOT="${LOCAL_DIR}/files" \
  AGENT_SERVER_PUBLIC_ORIGIN="${DESKTOP_URL}" \
  AGENT_SERVER_CORS_ORIGINS="${DESKTOP_URL},http://localhost:${DESKTOP_PORT}" \
  "${SERVER_DIR}/.venv/bin/uvicorn" \
  agent_server.app:create_app \
  --factory \
  --host 127.0.0.1 \
  --port "${SERVER_PORT}"
wait_for_url "${SERVER_URL}/api/v2/health" "Server" 60

printf '[desktop] starting on %s with local API %s\n' "${DESKTOP_URL}" "${SERVER_URL}"
start_screen_session \
  "${DESKTOP_SESSION}" \
  "${DESKTOP_DIR}" \
  "${DESKTOP_LOG}" \
  env \
  WORKBENCH_WEB_PORT="${DESKTOP_PORT}" \
  WORKBENCH_API_ORIGIN="${SERVER_URL}" \
  WORKBENCH_API_NAMESPACE=/api/v2 \
  AGENTS_ANYWHERE_API="${SERVER_URL}" \
  AGENTS_ANYWHERE_API_NAMESPACE=/api/v2 \
  corepack yarn dev
wait_for_url "${DESKTOP_URL}" "Desktop renderer" 120
wait_for_url "${DESKTOP_URL}/api/v2/health" "Desktop API proxy" 30

proxy_server="$(curl --silent --show-error --max-time 5 --dump-header - --output /dev/null \
  "${DESKTOP_URL}/api/v2/health" | awk 'tolower($1) == "server:" {gsub("\\r", "", $2); print tolower($2); exit}')"
[[ "${proxy_server}" == "uvicorn" ]] || \
  fail "Desktop API proxy did not reach the local uvicorn backend (server=${proxy_server:-missing})"

printf '\nLocal Desktop stack is ready.\n'
printf '  Desktop:   %s\n' "${DESKTOP_URL}"
printf '  Server:    %s\n' "${SERVER_URL}"
printf '  API proxy: %s/api/v2 -> %s/api/v2\n' "${DESKTOP_URL}" "${SERVER_URL}"
printf '  Logs:      %s\n' "${LOG_DIR}"
printf '  Stop:      ./desktop-local-up.sh down\n'
