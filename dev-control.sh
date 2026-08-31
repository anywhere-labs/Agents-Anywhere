#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${ROOT_DIR}/server/.venv/bin/python"
SESSION="aa-dev-control"
PORT="${DEV_CONTROL_PORT:-8765}"
LOG_FILE="${ROOT_DIR}/.local-dev/logs/dev-control.log"

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

session_exists() {
  screen -ls 2>/dev/null | grep -q "[.]${SESSION}[[:space:]]"
}

start_control() {
  [[ -x "${PYTHON}" ]] || fail "missing Server virtualenv; run ./local-up.sh once"
  if session_exists; then
    printf 'Dev Control is already running: http://127.0.0.1:%s\n' "${PORT}"
    return
  fi
  mkdir -p "${ROOT_DIR}/.local-dev/logs"
  screen -dmS "${SESSION}" zsh -lc \
    "cd $(printf '%q' "${ROOT_DIR}") && exec $(printf '%q' "${PYTHON}") -m devtools.control serve --port $(printf '%q' "${PORT}") >> $(printf '%q' "${LOG_FILE}") 2>&1"
  for _ in {1..50}; do
    if curl --fail --silent --output /dev/null "http://127.0.0.1:${PORT}/api/status"; then
      printf 'Dev Control: http://127.0.0.1:%s\n' "${PORT}"
      return
    fi
    sleep 0.1
  done
  fail "Dev Control did not start; check ${LOG_FILE}"
}

case "${1:-start}" in
  start)
    start_control
    ;;
  stop)
    if session_exists; then
      screen -S "${SESSION}" -X quit
    fi
    ;;
  serve|restart|status)
    exec "${PYTHON}" -m devtools.control "$@"
    ;;
  *)
    fail "usage: ./dev-control.sh [start|stop|serve|status|restart server|restart connector|restart all]"
    ;;
esac
