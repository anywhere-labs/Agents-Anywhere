"""Validate slash input before any native operation can be dispatched."""

import re

from connector.runtimes.codex.domain.commands import ALIASES


def command_input(
    command: str, raw: str | None, args: tuple[str, ...]
) -> tuple[str, str]:
    if not isinstance(command, str) or not re.fullmatch(
        r"/?[A-Za-z][A-Za-z0-9_-]*", command
    ):
        raise ValueError("Invalid command name")
    name = command.removeprefix("/").lower()
    name = ALIASES.get(name, name)
    if not isinstance(args, (tuple, list)) or any(
        not isinstance(arg, str) for arg in args
    ):
        raise ValueError("Command arguments must be strings")
    if raw is not None:
        if not isinstance(raw, str) or len(raw) > 4096:
            raise ValueError("Command raw input must contain at most 4096 characters")
        match = re.fullmatch(r"\s*/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?", raw)
        if not match or ALIASES.get(match[1].lower(), match[1].lower()) != name:
            raise ValueError("Raw command must match the requested command")
        text = match[2] or ""
    else:
        if len(args) > 1:
            raise ValueError("Provide one free-form argument or exact raw input")
        text = args[0] if args else ""
    return name, text
