from __future__ import annotations

import shutil
from typing import Any

from connector.runtimes.cli_headless.acp_client import acp_argv
from connector.runtimes.cli_headless.attachments import HeadlessTurnAttachment
from connector.runtimes.cli_headless.discovery import codebuddy_cli, minimax_cli

CONFIG_SCHEMA_REVISION = 2

CAPABILITIES: dict[str, bool] = {
    "modelCatalog": True,
    "permissionCatalog": False,
    "sessionDiscovery": False,
    "sessionSnapshot": True,
    "sessionState": True,
    "sessionNotices": False,
    "createAndStartSession": True,
    "startTurn": True,
    "steerTurn": False,
    "interruptTurn": True,
    "commands": False,
    "interactions": False,
    "attachments": True,
    "ipc": False,
}


def minimax_argv(
    prompt: str,
    workspace: str | None,
    model: str | None,
    cli_session: str | None,
    attachments: tuple[HeadlessTurnAttachment, ...] = (),
) -> list[str] | None:
    """MiniMax Code: `mcode exec --prompt-mode work --output-format stream-json`."""
    cli = minimax_cli()
    if cli is None:
        return None
    head: list[str]
    if cli.lower().endswith(".js"):
        node = shutil.which("node")
        if node is None:
            return None
        head = [node, cli]
    elif cli.lower().endswith((".cmd", ".bat")):
        head = ["cmd", "/d", "/c", cli]
    else:
        head = [cli]
    argv = head + [
        "exec",
        "--prompt-mode",
        "work",
        "--output-format",
        "stream-json",
    ]
    if cli_session:
        argv += ["--session", cli_session]
    for attachment in attachments:
        argv += ["--file", attachment.path]
    argv.append(prompt)
    return argv


def minimax_acp_command() -> list[str] | None:
    """Persistent `mcode acp` command, or None when the CLI is absent.

    The one-shot path pays the CLI's start-up on every message (~11s measured
    for mcode 0.6.5); the ACP server pays it once per runtime and then answers
    prompts on the same process.
    """

    cli = minimax_cli()
    if cli is None:
        return None
    return acp_argv(cli)


def codebuddy_argv(
    prompt: str,
    workspace: str | None,
    model: str | None,
    cli_session: str | None,
    attachments: tuple[HeadlessTurnAttachment, ...] = (),
) -> list[str] | None:
    """CodeBuddy: `codebuddy -p -y --output-format stream-json`."""
    cli = codebuddy_cli()
    if cli is None:
        return None
    argv = [
        cli,
        "-p",
        "-y",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
    ]
    if model:
        argv += ["--model", model]
    if cli_session:
        # First turn: the session does not exist yet, so it is created with the
        # same id thanks to --resume-create-missing. Later turns resume it.
        argv += ["--resume", cli_session, "--resume-create-missing"]
    argv.append(content_with_attachment_notes(prompt, attachments))
    if cli.lower().endswith((".cmd", ".bat")):
        return ["cmd", "/d", "/c"] + argv
    return argv


def content_with_attachment_notes(
    content: str,
    attachments: tuple[HeadlessTurnAttachment, ...],
) -> str:
    if not attachments:
        return content
    notes = "\n".join(
        f"- {attachment.name}: {attachment.path} ({attachment.media_type},"
        f" {attachment.byte_size} bytes)"
        for attachment in attachments
    )
    return f"{content}\n\nAttached files:\n{notes}"


def shared_config_schema() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Return (schema, ui_schema, defaults) shared by every headless kernel."""
    schema: dict[str, Any] = {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "workspaceDir": {
                "type": "string",
                "description": "Default working directory for new sessions",
            },
        },
    }
    ui_schema: dict[str, Any] = {
        "order": ["defaultModel", "workspaceDir"],
        "workspaceDir": {"component": "path"},
    }
    return schema, ui_schema, {}


def with_default_model(
    schema: dict[str, Any],
    ui_schema: dict[str, Any],
    defaults: dict[str, Any],
    models: tuple[tuple[str, str], ...],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Extend the shared schema with a defaultModel select when models exist."""
    if not models:
        return schema, ui_schema, defaults
    properties = dict(schema["properties"])
    properties["defaultModel"] = {
        "type": "string",
        "enum": [model_id for model_id, _title in models],
        "description": "Model used by new sessions",
    }
    ui = dict(ui_schema)
    ui["defaultModel"] = {
        "component": "select",
        "options": [{"value": model_id, "label": title} for model_id, title in models],
    }
    merged = {**defaults, "defaultModel": models[0][0]}
    return {**schema, "properties": properties}, ui, merged