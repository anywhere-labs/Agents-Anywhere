"""Translate AA's existing model form into a private Pi configuration."""
from __future__ import annotations

import json
import os
from pathlib import Path
from uuid import uuid4

import httpx

from ...domain.definitions import AcpError


def private_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name("." + path.name + "." + uuid4().hex)
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _default_model(models: list[dict], values: dict) -> str:
    """The configured model when Pi has it, else the first one; Pi starts new sessions with it."""
    configured = (values.get("model") or {}).get("modelId")
    ids = [model["modelId"] for model in models]
    return configured if configured in ids else ids[0]


def update_default_model(agent_dir: Path, values: dict) -> None:
    """Point new sessions at another configured model without restarting Pi.

    Each session starts its own Pi process, which reads settings.json then;
    existing sessions keep the model saved in their session file.
    """
    settings_path = agent_dir / "settings.json"
    settings = json.loads(settings_path.read_text(encoding="utf-8"))
    provider = json.loads((agent_dir / "models.json").read_text(encoding="utf-8"))["providers"]["aa"]
    models = [{"modelId": model["id"]} for model in provider["models"]]
    settings["defaultModel"] = _default_model(models, values)
    private_json(settings_path, settings)


def prepare_settings(root: Path, values: dict) -> Path:
    agent_dir = root / "pi"
    gateway = values.get("modelGateway")
    models = values.get("customModels", [])
    if gateway:
        if not models:
            try:
                with httpx.Client(timeout=30) as client:
                    result = client.get(gateway["baseUrl"] + "/models", headers={"Authorization": "Bearer " + gateway["apiKey"]})
                    result.raise_for_status()
                    models = [{"modelId": item["id"], "displayName": item["id"]} for item in result.json()["data"] if isinstance(item.get("id"), str)][:64]
            except (httpx.HTTPError, ValueError, KeyError, TypeError) as error:
                raise AcpError("pi_models_unavailable", "无法获取模型列表，请在自定义模型中填写模型 ID 后重试。") from error
        if not models:
            raise AcpError("pi_models_required", "请在自定义模型中至少添加一个模型。")
        private_json(agent_dir / "models.json", {"providers": {"aa": {
            "baseUrl": gateway["baseUrl"], "api": "openai-completions", "apiKey": "${AA_PI_GATEWAY_KEY}",
            "models": [{"id": model["modelId"], "name": model["displayName"],
                        "reasoning": bool(model.get("efforts")), "input": ["text", "image"],
                        "contextWindow": 128000, "maxTokens": 16384,
                        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}
                       for model in models],
        }}})
    settings = {"defaultProvider": "aa", "defaultModel": _default_model(models, values)} if gateway else {}
    settings["extensions"] = [str(Path(__file__).with_name("permissions.mjs").resolve())]
    # This is AA's isolated home, never the user's global Pi settings.
    private_json(agent_dir / "settings.json", settings)
    return agent_dir
