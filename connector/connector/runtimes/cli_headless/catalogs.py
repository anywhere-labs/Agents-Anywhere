from __future__ import annotations

import json
from pathlib import Path

# Built-in models reported by `codebuddy --help`. The CLI upgrades over time,
# so this list is merged with the user-defined models read from
# ~/.codebuddy/models.json (exposed by the CLI as custom-local:<id>).
BUILTIN_CODEBUDDY_MODELS: tuple[tuple[str, str], ...] = (
    ("hy4-preview", "Hy4 Preview (default, reasoning, strongest but slowest)"),
    ("glm-5.3-flashx", "GLM-5.3 FlashX (fastest)"),
    ("glm-5.3-flash", "GLM-5.3 Flash (fast)"),
    ("deepseek-v4.1-flash", "DeepSeek V4.1 Flash (fast)"),
    ("glm-5.2", "GLM-5.2 (balanced)"),
    ("kimi-k2.8-preview", "Kimi K2.8 Preview"),
)

CODEBUDDY_MODELS_DIR = Path.home() / ".codebuddy"
CODEBUDDY_MODELS_FILE = "models.json"


def custom_codebuddy_models() -> tuple[tuple[str, str], ...]:
    """Read user-defined models from ~/.codebuddy/models.json.

    The CLI exposes these as custom-local:<id>; keep the same ids so
    --model accepts them.
    """
    try:
        data = json.loads(
            (CODEBUDDY_MODELS_DIR / CODEBUDDY_MODELS_FILE).read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return ()
    raw_models = data.get("models") if isinstance(data, dict) else None
    if not isinstance(raw_models, list):
        return ()
    models: list[tuple[str, str]] = []
    for raw in raw_models:
        if not isinstance(raw, dict):
            continue
        model_id = raw.get("id")
        if not isinstance(model_id, str) or not model_id:
            continue
        name = raw.get("name")
        title = name if isinstance(name, str) and name else model_id
        models.append((f"custom-local:{model_id}", f"{title} (custom)"))
    return tuple(models)


def codebuddy_models() -> tuple[tuple[str, str], ...]:
    return BUILTIN_CODEBUDDY_MODELS + custom_codebuddy_models()