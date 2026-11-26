FROM python:3.12-slim

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:0.12.3 /uv /usr/local/bin/uv

COPY pyproject.toml alembic.ini ./
COPY aa_control ./aa_control
COPY migrations ./migrations

RUN uv sync --no-dev

ENV AA_CONTROL_HOST=0.0.0.0 \
    AA_CONTROL_PORT=8080

EXPOSE 8080

CMD ["uv", "run", "--no-sync", "python", "-m", "aa_control.main"]
