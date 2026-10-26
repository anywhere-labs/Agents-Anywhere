#!/usr/bin/env sh
set -eu

: "${AGENT_SERVER_DB_URL:?Set AGENT_SERVER_DB_URL to a postgresql+asyncpg URL}"
export AGENT_SERVER_DB_URL

uv run python -m agent_server.infra.db.migrations upgrade
exec uv run python -m agent_server.main --host 127.0.0.1 --port 8000
