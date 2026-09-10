from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from connector.logging import logger
from connector.runtimes.model_gateway import model_gateway_from_config


def create_gateway_settings_file(config_values: Mapping[str, Any]) -> str | None:
    model_gateway = model_gateway_from_config(config_values.get("modelGateway"))
    if model_gateway is None:
        return None

    file_descriptor, raw_path = tempfile.mkstemp(
        prefix="agents-anywhere-claude-",
        suffix=".json",
    )
    path = Path(raw_path)
    try:
        os.chmod(path, 0o600)
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as settings_file:
            json.dump(
                {
                    "env": {
                        "ANTHROPIC_BASE_URL": model_gateway.base_url,
                        "ANTHROPIC_AUTH_TOKEN": model_gateway.api_key,
                        "ANTHROPIC_API_KEY": "",
                    }
                },
                settings_file,
                ensure_ascii=True,
                separators=(",", ":"),
            )
            settings_file.write("\n")
    except BaseException:
        try:
            os.close(file_descriptor)
        except OSError:
            pass
        path.unlink(missing_ok=True)
        raise
    return str(path)


def remove_gateway_settings_file(path: str | None) -> None:
    if path is None:
        return
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        logger.exception("Claude Gateway settings cleanup failed path={}", path)
