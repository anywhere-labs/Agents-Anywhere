from __future__ import annotations

import os
import shutil

MINIMAX_CLI_ENV = "MINIMAX_CLI_JS"


def minimax_cli() -> str | None:
    """Locate the MiniMax Code CLI (``mcode``).

    Set MINIMAX_CLI_JS to point at a specific cli.js entrypoint; otherwise
    the npm-global ``mcode`` launcher on PATH is used.
    """
    override = os.environ.get(MINIMAX_CLI_ENV)
    if override and os.path.isfile(override):
        return override
    return shutil.which("mcode")


def minimax_available() -> bool:
    cli = minimax_cli()
    if cli is None:
        return False
    if cli.lower().endswith(".js"):
        return shutil.which("node") is not None
    return True


def codebuddy_cli() -> str | None:
    return shutil.which("codebuddy")


def codebuddy_available() -> bool:
    return codebuddy_cli() is not None