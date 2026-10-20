"""Keep the Connector's own launch environment out of the processes it starts.

Desktop and the DSH plugin start the Connector with ``uv run`` and toolchain
settings (uv project environment, cache, package index, Python flags). uv then
adds ``VIRTUAL_ENV`` and puts the Connector venv first on ``PATH``. Terminals and
Runtimes must see the user's environment instead: otherwise ``uv sync`` in a
terminal syncs the Connector venv and removes its packages, and ``python``
resolves to the Connector's interpreter.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Mapping

from connector.logging import logger

# JSON object set by the host: variable name -> value before the host set it,
# or null when the variable was not set.
INJECTED_ENV_VAR = "AA_CONNECTOR_INJECTED_ENV"
# Set by ``uv run`` for the Connector itself.
UV_RUN_ENV_NAMES = ("UV", "UV_RUN_RECURSION_DEPTH")
CONNECTOR_ENV_PREFIXES = ("AGENT_CONNECTOR_", "AA_CONNECTOR_")
# AGENT_SERVER_URL is Connector configuration; other AGENT_SERVER_* names (for
# example AGENT_SERVER_TEST_DB_URL) belong to the user's own development work.
CONNECTOR_ENV_NAMES = frozenset({"AGENT_SERVER_URL"})

_connector_environ: dict[str, str] | None = None


def child_environment(
    base: Mapping[str, str] | None = None,
    *,
    prefix: str | None = None,
    base_prefix: str | None = None,
) -> dict[str, str]:
    """Return the environment for a terminal or Runtime started by the Connector.

    Host-injected variables go back to their previous values, ``uv run``
    variables and Connector settings are removed, and the Connector venv's
    scripts directory leaves ``PATH``. Variables the user set are kept, and an
    already clean environment is returned unchanged.
    """

    environment = dict(os.environ if base is None else base)
    for name, original in _injected_originals(environment.pop(INJECTED_ENV_VAR, None)).items():
        if original is None:
            environment.pop(name, None)
        else:
            environment[name] = original

    venv = sys.prefix if prefix is None else prefix
    system = sys.base_prefix if base_prefix is None else base_prefix
    for name in UV_RUN_ENV_NAMES:
        environment.pop(name, None)
    if not _same_path(venv, system):
        if _same_path(environment.get("VIRTUAL_ENV"), venv):
            environment.pop("VIRTUAL_ENV", None)
        scripts = os.path.join(venv, "Scripts" if os.name == "nt" else "bin")
        for name in [key for key in environment if key.upper() == "PATH"]:
            entries = environment[name].split(os.pathsep)
            kept = [entry for entry in entries if not _same_path(entry, scripts)]
            if len(kept) != len(entries):
                environment[name] = os.pathsep.join(kept)

    for name in list(environment):
        if name in CONNECTOR_ENV_NAMES or name.startswith(CONNECTOR_ENV_PREFIXES):
            del environment[name]
    return environment


def isolate_process_environment() -> None:
    """Keep Connector settings private and leave ``os.environ`` clean for children.

    The Claude and Codex SDKs merge ``os.environ`` into every process they
    start, so an explicit child environment alone cannot remove inherited
    variables. Connector code reads its own settings through ``connector_env``.
    """

    global _connector_environ
    if _connector_environ is not None:
        return
    _connector_environ = dict(os.environ)
    clean = child_environment(_connector_environ)
    for name in [name for name in os.environ if name not in clean]:
        del os.environ[name]
    for name, value in clean.items():
        if os.environ.get(name) != value:
            os.environ[name] = value


def connector_env(name: str, default: str | None = None) -> str | None:
    """Read a Connector setting from the environment the Connector started with."""

    source = os.environ if _connector_environ is None else _connector_environ
    return source.get(name, default)


def _injected_originals(raw: str | None) -> dict[str, str | None]:
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except ValueError:
        logger.warning("ignoring malformed {}", INJECTED_ENV_VAR)
        return {}
    if not isinstance(payload, dict):
        logger.warning("ignoring malformed {}", INJECTED_ENV_VAR)
        return {}
    return {
        name: original
        for name, original in payload.items()
        if isinstance(name, str) and (original is None or isinstance(original, str))
    }


def _same_path(left: str | None, right: str | None) -> bool:
    if not left or not right:
        return False
    return _normalized(left) == _normalized(right)


def _normalized(path: str) -> str:
    return os.path.normcase(os.path.normpath(path.strip().strip('"')))
