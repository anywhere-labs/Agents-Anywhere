FROM node:22-bookworm-slim AS web-build

WORKDIR /app/web
COPY web/package.json web/yarn.lock ./
RUN corepack enable && yarn install --immutable
COPY web/index.html web/tsconfig.json web/vite.config.ts ./
COPY web/public ./public
COPY web/src ./src
COPY web/test ./test
RUN yarn build

FROM python:3.12-slim

ARG APT_MIRROR=

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PYTHONPATH=/app/server \
    AGENT_SERVER_DB=/data/agent-server.sqlite3 \
    AGENT_SERVER_STATIC_DIR=/app/web-dist

WORKDIR /app

RUN if [ -n "$APT_MIRROR" ]; then \
        sed -i "s|http://deb.debian.org/debian|$APT_MIRROR|g; s|http://deb.debian.org/debian-security|$APT_MIRROR-security|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv

COPY server/pyproject.toml server/uv.lock ./server/
RUN cd server && uv sync --frozen --no-dev --no-install-project

COPY server ./server
COPY --from=web-build /app/web/dist ./web-dist

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8000
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "cd /app/server && uv run --no-sync uvicorn agent_server.app:create_app --factory --host 0.0.0.0 --port 8000"]
