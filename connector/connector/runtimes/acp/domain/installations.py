from __future__ import annotations

import re
from dataclasses import dataclass

from .definitions import AcpError, fingerprint


@dataclass(frozen=True)
class AgentInstallation:
    release_id: str
    profile_id: str
    platform: str
    architecture: str
    status: str = "ready"


def release_identity(manifest: dict) -> str:
    return fingerprint(manifest)


def validate_manifest(manifest: dict) -> None:
    required = {
        "schemaVersion",
        "profileId",
        "platform",
        "architecture",
        "launcher",
        "files",
        "provenance",
        "protocols",
        "guarantees",
    }
    if not required <= manifest.keys() or manifest["schemaVersion"] != "1.0":
        raise AcpError("invalid_component_manifest", "组件清单结构不完整。")
    if manifest["platform"] not in {"darwin", "linux", "win32"} or manifest[
        "architecture"
    ] not in {"x64", "arm64"}:
        raise AcpError("unsupported_component_target", "组件目标平台不受支持。")
    if (
        not isinstance(manifest["files"], dict)
        or not manifest["files"]
        or len(manifest["files"]) > 50000
    ):
        raise AcpError("invalid_component_files", "组件文件清单无效。")
    for value in manifest["files"].values():
        if (
            isinstance(value, dict)
            and "executable" in value
            and type(value["executable"]) is not bool
        ):
            raise AcpError("invalid_component_files", "组件文件执行标记无效。")
        if (
            not isinstance(value, dict)
            or not re.fullmatch(r"[0-9a-f]{64}", str(value.get("sha256", "")))
            or type(value.get("size")) is not int
            or value["size"] < 0
        ):
            raise AcpError("invalid_component_files", "组件文件校验信息无效。")
    if sum(value["size"] for value in manifest["files"].values()) > 512 * 1024 * 1024:
        raise AcpError("component_too_large", "组件展开大小超过上限。")
    launcher = manifest["launcher"]
    if (
        not isinstance(launcher, dict)
        or not isinstance(launcher.get("executable"), str)
        or launcher["executable"] not in manifest["files"]
        or not isinstance(launcher.get("arguments"), list)
        or not all(isinstance(arg, str) for arg in launcher["arguments"])
        or manifest["files"][launcher["executable"]].get("executable") is not True
    ):
        raise AcpError("invalid_component_entry", "组件缺少受管理的可执行入口。")
    if manifest["protocols"] != [1]:
        raise AcpError(
            "unsupported_component_protocol", "当前只接受已启用的 ACP v1 组件。"
        )
