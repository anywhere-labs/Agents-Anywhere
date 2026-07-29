from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from agent_server.infra.db.schema import metadata

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)
target_metadata = metadata

_PRESERVED_V1_TABLES = {
    "agent_efforts",
    "agent_models",
    "agent_modes",
    "device_agent_settings",
    "user_agent_defaults",
}
_PRESERVED_V1_COLUMNS = {
    ("connectors", "runtime_capabilities"),
    ("sessions", "runtime_settings_override"),
}


def include_object(
    obj, name: str | None, type_: str, reflected: bool, compare_to
) -> bool:
    if not reflected or compare_to is not None:
        return True
    if type_ == "table" and name in _PRESERVED_V1_TABLES:
        return False
    return not (
        type_ == "column"
        and (getattr(obj.table, "name", None), name) in _PRESERVED_V1_COLUMNS
    )


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        include_object=include_object,
    )
    with context.begin_transaction():
        context.run_migrations()


def _run_migrations(connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        include_object=include_object,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
