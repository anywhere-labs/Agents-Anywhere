#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
STATE_DIR="${LOADTEST_STATE_DIR:-${REPO_ROOT}/.local-dev/loadtest/connector-ws}"
DATA_FILE="${LOADTEST_DATA_FILE:-${STATE_DIR}/data.json}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8000}"

usage() {
  printf '%s\n' \
    "Usage: $0 prepare [generator options]" \
    "       $0 smoke|steady|append|reconnect" \
    "       $0 cleanup" \
    "" \
    "Environment: VUS, TEST_DURATION, CONNECTION_SECONDS," \
    "MESSAGES_PER_SECOND, PAYLOAD_BYTES, CHECKPOINT_EVERY."
}

require_server() {
  curl --fail --silent --max-time 3 "${BASE_URL}/api/v2/health/ready" >/dev/null || {
    printf 'Server is not ready at %s; run ./local-up.sh first.\n' "${BASE_URL}" >&2
    exit 2
  }
}

run_generator() {
  (
    cd "${REPO_ROOT}/server"
    uv run python loadtests/connector_ws/generate_data.py "$@"
  )
}

require_k6() {
  command -v k6 >/dev/null 2>&1 || {
    printf '%s\n' "k6 is missing. Install it with: brew install k6" >&2
    exit 2
  }
}

run_load() {
  local profile="$1"
  require_server
  require_k6
  [[ -f "${DATA_FILE}" ]] || {
    printf 'Load-test data is missing: %s; run %s prepare first.\n' "${DATA_FILE}" "$0" >&2
    exit 2
  }

  local timestamp output_dir mode default_vus default_duration default_connection default_rate
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  output_dir="${STATE_DIR}/results/${timestamp}-${profile}"
  mkdir -p "${output_dir}"
  mode="steady"
  default_vus=8
  default_duration=5m
  default_connection=300
  default_rate=20

  case "${profile}" in
    smoke)
      default_vus=1
      default_duration=30s
      default_connection=29
      default_rate=2
      ;;
    steady) ;;
    append)
      mode=append
      default_rate=5
      ;;
    reconnect)
      default_duration=5m
      default_connection=5
      default_rate=2
      ;;
    *)
      usage
      exit 2
      ;;
  esac

  printf 'profile=%s output=%s\n' "${profile}" "${output_dir}"
  DATA_FILE="${DATA_FILE}" \
  BASE_URL="${BASE_URL}" \
  MODE="${MODE:-${mode}}" \
  VUS="${VUS:-${default_vus}}" \
  TEST_DURATION="${TEST_DURATION:-${default_duration}}" \
  CONNECTION_SECONDS="${CONNECTION_SECONDS:-${default_connection}}" \
  MESSAGES_PER_SECOND="${MESSAGES_PER_SECOND:-${default_rate}}" \
  PAYLOAD_BYTES="${PAYLOAD_BYTES:-1024}" \
  ITEMS_PER_SESSION="${ITEMS_PER_SESSION:-4}" \
  CHECKPOINT_EVERY="${CHECKPOINT_EVERY:-20}" \
  READBACK_INTERVAL_MS="${READBACK_INTERVAL_MS:-1000}" \
  TIMELINE_PERCENT="${TIMELINE_PERCENT:-80}" \
  STATE_PERCENT="${STATE_PERCENT:-10}" \
  RECONNECT_PAUSE_SECONDS="${RECONNECT_PAUSE_SECONDS:-1}" \
  K6_WEB_DASHBOARD=true \
  K6_WEB_DASHBOARD_EXPORT="${output_dir}/report.html" \
    k6 run \
      --summary-export "${output_dir}/summary.json" \
      "${SCRIPT_DIR}/connector-ws.js" \
      2>&1 | tee "${output_dir}/k6.log"
}

command="${1:-}"
[[ -n "${command}" ]] || {
  usage
  exit 2
}
shift

case "${command}" in
  prepare)
    require_server
    mkdir -p "${STATE_DIR}"
    run_generator prepare \
      --base-url "${BASE_URL}" \
      --output "${DATA_FILE}" \
      --setup-token-log "${REPO_ROOT}/.local-dev/logs/server.log" \
      "$@"
    ;;
  cleanup)
    require_server
    run_generator cleanup --base-url "${BASE_URL}" --output "${DATA_FILE}" "$@"
    ;;
  smoke|steady|append|reconnect)
    run_load "${command}"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    exit 2
    ;;
esac
