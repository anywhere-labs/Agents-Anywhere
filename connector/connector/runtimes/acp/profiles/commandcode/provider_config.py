from __future__ import annotations

from typing import Any

COMMAND_CODE_CONFIG_SCHEMA_REVISION = 1
MAX_CLI_PATH_LENGTH = 4096


def command_code_config_schema() -> dict[str, Any]:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "cliPath": {
                "type": "string",
                "title": "Command Code CLI path",
                "description": (
                    "Optional path to cmdc, command-code, or the package's "
                    "dist/index.mjs. Leave empty to detect the CLI."
                ),
                "metadata": {
                    "i18n": {
                        "labelKey": (
                            "dashboard.device.runtimeConfigFields."
                            "commandCodeCliPath.label"
                        ),
                        "descriptionKey": (
                            "dashboard.device.runtimeConfigFields."
                            "commandCodeCliPath.description"
                        ),
                    }
                },
                "maxLength": MAX_CLI_PATH_LENGTH,
            },
        },
        "additionalProperties": False,
    }


def command_code_capabilities() -> dict[str, bool]:
    return {
        "modelCatalog": True,
        "permissionCatalog": True,
        "sessionState": True,
        "sessionNotices": True,
        "startTurn": True,
        "steerTurn": False,
        "interruptTurn": True,
        "commands": False,
        "interactions": True,
        "attachments": True,
    }
