FROM node:22-bookworm-slim AS web-static

ARG YARN_REGISTRY=

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=export \
    AGENTS_ANYWHERE_API=

WORKDIR /app/web-next

COPY web-next/package.json ./
RUN corepack enable \
    && if [ -n "$YARN_REGISTRY" ]; then yarn config set npmRegistryServer "$YARN_REGISTRY"; fi \
    && YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install

COPY web-next ./
RUN yarn build


FROM python:3.12-slim AS server

ARG APT_MIRROR=
ARG PIP_INDEX_URL=

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PYTHONPATH=/app/server \
    AGENT_SERVER_DB=/data/agent-server.sqlite3 \
    AGENT_SERVER_STATIC_DIR=/app/web-static

WORKDIR /app

RUN if [ -n "$APT_MIRROR" ]; then \
        sed -i "s|http://deb.debian.org/debian|$APT_MIRROR|g; s|http://deb.debian.org/debian-security|$APT_MIRROR-security|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini git \
    && rm -rf /var/lib/apt/lists/* \
    && if [ -n "$PIP_INDEX_URL" ]; then pip config set global.index-url "$PIP_INDEX_URL"; fi \
    && pip install --no-cache-dir uv

COPY server/pyproject.toml ./server/
RUN if [ -n "$PIP_INDEX_URL" ]; then export UV_INDEX_URL="$PIP_INDEX_URL"; fi \
    && cd server && uv sync --no-dev --no-install-project

COPY server ./server
COPY --from=web-static /app/web-next/out ./web-static

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8000
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "cd /app/server && uv run --no-sync uvicorn agent_server.app:create_app --factory --host 0.0.0.0 --port 8000"]
