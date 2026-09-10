#!/usr/bin/env sh
set -eu

: "${AGENT_SERVER_DB_URL:?Set AGENT_SERVER_DB_URL to a postgresql+asyncpg URL}"
AGENT_SERVER_DB_BACKEND=postgres
export AGENT_SERVER_DB_BACKEND AGENT_SERVER_DB_URL

uv run python -m agent_server.infra.db.migrations upgrade
exec uv run uvicorn agent_server.app:create_app --factory --host 127.0.0.1 --port 8000
