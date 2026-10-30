from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .definitions import AcpError, fingerprint


@dataclass(frozen=True)
class ConfigurationSnapshot:
    options: tuple[dict[str, Any], ...] = ()
    revision: int = 0

    def replace_options(self, options: list[dict]) -> ConfigurationSnapshot:
        seen = set()
        for item in options:
            key = item.get("configId", item.get("id"))
            if not isinstance(key, str) or not key or key in seen:
                raise AcpError(
                    "invalid_agent_configuration", "Agent 配置身份无效或重复。"
                )
            seen.add(key)
        changed = fingerprint(options) != fingerprint(self.options)
        return ConfigurationSnapshot(tuple(options), self.revision + int(changed))

    def validate(self, values: dict) -> None:
        index = {item.get("configId", item.get("id")): item for item in self.options}
        for key, value in values.items():
            option = index.get(key)
            if not option:
                raise AcpError("configuration_changed", "配置选项已不可用。")
            if option["type"] == "boolean":
                valid = isinstance(value, bool)
            elif option["type"] == "select":
                choices = option.get("options", [])
                flattened = [
                    child
                    for group in choices
                    for child in (
                        group.get("options", []) if "options" in group else [group]
                    )
                ]
                valid = isinstance(value, str) and any(
                    item.get("value") == value for item in flattened
                )
            else:
                valid = False
            if not valid:
                raise AcpError(
                    "invalid_configuration_value", "配置值不在当前可用范围。"
                )

    def merge_legacy(self, values: dict, selections: dict) -> dict:
        from .catalogs import decode_selection

        selections = dict(selections)
        if selections.get("model") is not None:
            decoded = decode_selection(selections["model"])
            if "effort" in decoded and selections.get("effort") not in (None, decoded["effort"]):
                raise AcpError("configuration_conflict", "模型选择与推理强度不一致。")
            selections.update(decoded)
        merged = dict(values)
        for category, value in selections.items():
            if value is None:
                continue
            options = [
                option for option in self.options if option.get("category") == category
            ]
            if len(options) != 1:
                raise AcpError(
                    "configuration_mapping_unavailable",
                    "该旧选择没有唯一且无损的 Agent 配置映射。",
                )
            key = options[0].get("configId", options[0].get("id"))
            if key in merged and merged[key] != value:
                raise AcpError("configuration_conflict", "旧选择与通用配置不一致。")
            merged[key] = value
        self.validate(merged)
        return merged
