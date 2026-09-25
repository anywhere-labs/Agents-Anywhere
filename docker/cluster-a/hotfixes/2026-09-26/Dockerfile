FROM agents-anywhere:realtime-a4e1e762
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision=$SOURCE_REVISION \
      aa.maintenance.schema="v2_36" \
      aa.maintenance.base="realtime-a4e1e762"
# Server dependencies are unchanged from the verified production image.
COPY server/agent_server /app/server/agent_server
COPY server/migrations /app/server/migrations
COPY server/scripts /app/server/scripts
COPY server/alembic.ini /app/server/alembic.ini
RUN rm -rf /app/web-static
COPY web-next/out /app/web-static
