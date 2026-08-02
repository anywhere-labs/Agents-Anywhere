from __future__ import annotations

import asyncio
import importlib
import os
import shutil
import sys
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from connector.acp.discovery import discover_acp_manifest
from connector.acp.manifest import AgentManifest, load_builtin_manifests
from connector.launch import LaunchTarget, launch_target, path_exists_for_launch
from connector.codex.rpc import JsonRpcStdioClient, codex_candidate_paths
from connector.logging import logger


_CODEX_CHECK_TIMEOUT_S = 8.0
_COMMAND_CHECK_TIMEOUT_S = 8.0
_CODEX_MODEL_PAGE_SIZE = 100
_CODEX_MODEL_MAX_PAGES = 100


@dataclass(frozen=True, slots=True)
class RuntimeDiscovery:
    report: dict[str, Any]
    codex_bin: str | None = None
    claude_bin: str | None = None
    codex_target: LaunchTarget | None = None
    claude_target: LaunchTarget | None = None
    acp_targets: dict[str, LaunchTarget | None] | None = None


async def discover_runtime_capabilities() -> RuntimeDiscovery:
    """Discover all runtimes in parallel with *light* ACP probes.

    Previously every ACP agent was deep-probed sequentially (spawn + session/new),
    which could take minutes and starve the event loop / reconnect loop.
    """
    started = time.perf_counter()
    manifests = load_builtin_manifests()

    async def _one_acp(manifest: AgentManifest) -> tuple[str, dict[str, Any], LaunchTarget | None]:
        report, target = await discover_acp_manifest(manifest, deep_probe=False)
        return manifest.id, report, target

    codex_task = asyncio.create_task(discover_codex_capability())
    claude_task = asyncio.create_task(discover_claude_capability())
    acp_tasks = [asyncio.create_task(_one_acp(m)) for m in manifests]

    codex_report, codex_target = await codex_task
    claude_report, claude_target = await claude_task
    acp_results = await asyncio.gather(*acp_tasks, return_exceptions=True)

    runtimes: dict[str, Any] = {
        "codex": codex_report,
        "claude": claude_report,
    }
    acp_targets: dict[str, LaunchTarget | None] = {}
    for result in acp_results:
        if isinstance(result, BaseException):
            logger.exception("ACP discovery task failed: {}", result)
            continue
        runtime_id, report, target = result
        runtimes[runtime_id] = report
        acp_targets[runtime_id] = target

    elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
    logger.info(
        "runtime capability discovery finished elapsed_ms={} acp_agents={}",
        elapsed_ms,
        len(acp_targets),
    )
    return RuntimeDiscovery(
        report={
            "version": 1,
            "checkedAt": _now_iso(),
            "elapsedMs": elapsed_ms,
            "runtimes": runtimes,
        },
        codex_bin=codex_target.path if codex_target else None,
        claude_bin=claude_target.path if claude_target else None,
        codex_target=codex_target,
        claude_target=claude_target,
        acp_targets=acp_targets,
    )


async def discover_acp_capability(
    runtime: str,
    *,
    extra_candidate: str | None = None,
    manifests: list[AgentManifest] | None = None,
) -> tuple[dict[str, Any], LaunchTarget | None]:
    for manifest in manifests if manifests is not None else load_builtin_manifests():
        if manifest.id == runtime:
            return await discover_acp_manifest(manifest, extra_candidate=extra_candidate)
    return (
        {
            "history": "unavailable",
            "execution": "unavailable",
            "transport": "acp",
            "error": {
                "code": "unknown_acp_runtime",
                "message": f"No ACP manifest registered for runtime {runtime!r}",
            },
            "checked": [],
        },
        None,
    )


async def discover_codex_capability(
    *, extra_candidate: str | None = None
) -> tuple[dict[str, Any], LaunchTarget | None]:
    """Scan the local machine for a usable Codex install.

    `extra_candidate`, when set, is checked first as `source="custom"`. Used
    by the per-runtime scan endpoint when the user types a custom path in the
    Add Agent modal.
    """
    candidates = codex_candidate_paths()
    if extra_candidate:
        candidates = _dedupe_candidates(
            [{"source": "custom", "path": extra_candidate}, *candidates]
        )
    checked: list[dict[str, Any]] = []
    for candidate in candidates:
        target = _target_from_candidate(candidate)
        result = await _check_codex_candidate(candidate)
        checked.append(result)
        if result["status"] == "ok":
            report: dict[str, Any] = {
                "history": "ok",
                "execution": "ok",
                "selected": _selected_from_check(result),
                "checked": checked,
            }
            if isinstance(result.get("modelOptions"), list):
                # Runtime reports are persisted by the server exactly at this
                # level. Keep the selected candidate's live catalog available
                # to device/session schema validation and clients.
                report["modelOptions"] = result["modelOptions"]
            return (
                report,
                target,
            )
    return (
        {
            "history": "unavailable",
            "execution": "unavailable",
            "error": {
                "code": "codex_unavailable",
                "message": (
                    "Codex is unavailable or broken. Checked custom path, Codex App, "
                    "and Codex CLI. Plugin-based Codex installations are not supported yet."
                ),
            },
            "checked": checked,
        },
        None,
    )


async def discover_claude_capability(
    *, extra_candidate: str | None = None
) -> tuple[dict[str, Any], LaunchTarget | None]:
    history = _check_claude_history()
    candidates = _claude_candidate_paths()
    if extra_candidate:
        candidates = _dedupe_candidates(
            [{"source": "custom", "path": extra_candidate}, *candidates]
        )
    checked: list[dict[str, Any]] = []
    selected_target: LaunchTarget | None = None
    execution = "unavailable"
    for candidate in candidates:
        target = _target_from_candidate(candidate)
        result = await _check_claude_candidate(candidate)
        checked.append(result)
        if result["status"] == "ok":
            selected_target = target
            execution = "ok"
            break

    report: dict[str, Any] = {
        "history": history["status"],
        "execution": execution,
        "historyCheck": history,
        "checked": checked,
    }
    if selected_target is not None:
        report["selected"] = _selected_from_check(checked[-1])
    else:
        report["error"] = {
            "code": "claude_cli_unavailable",
            "message": "Claude Code is unavailable or broken. Checked CLAUDE_BIN, PATH, and common install paths.",
        }
    return report, selected_target


async def _check_codex_candidate(candidate: dict[str, str] | LaunchTarget) -> dict[str, Any]:
    target = _target_from_candidate(candidate)
    path = target.path
    source = target.source
    base = {"source": source, "path": path}
    if not Path(path).is_file():
        return {**base, "status": "missing", "reason": "file not found"}
    if not path_exists_for_launch(path):
        return {**base, "status": "failed", "reason": "not executable"}

    version = await _run_version(target.command(["--version"]))
    if version["status"] != "ok":
        return {**base, "status": "failed", "stage": "version", **version}

    client = JsonRpcStdioClient(command=target.command(["app-server", "--listen", "stdio://"]))
    try:
        await asyncio.wait_for(client.start(lambda _payload: _noop()), timeout=_CODEX_CHECK_TIMEOUT_S)
        list_result = await asyncio.wait_for(
            client.request("thread/list", {"limit": 1, "sortKey": "updated_at"}),
            timeout=_CODEX_CHECK_TIMEOUT_S,
        )
        model_options = await asyncio.wait_for(
            _read_codex_model_options(client),
            timeout=_CODEX_CHECK_TIMEOUT_S,
        )
    except Exception as exc:
        stage = "model-list" if "model_options" in locals() or _is_model_list_error(exc) else "app-server"
        return {
            **base,
            "status": "failed",
            "stage": stage,
            "version": version.get("stdout"),
            "reason": _exception_reason(exc),
        }
    finally:
        try:
            await client.close()
        except Exception:
            pass

    return {
        **base,
        "status": "ok",
        "version": version.get("stdout"),
        "threadListKeys": sorted(list_result.keys()),
        "modelOptions": model_options,
    }


async def _read_codex_model_options(client: JsonRpcStdioClient) -> list[dict[str, Any]]:
    """Read every model/list page from the already-started app-server.

    Discovery must prove that the selected Codex can execute the catalog we
    advertise.  Treat absent, malformed, or empty catalogs as unavailable
    instead of defaulting to a GPT-5.6 model that an older CLI rejects.
    """
    options: list[dict[str, Any]] = []
    seen_models: set[str] = set()
    cursor: str | None = None
    seen_cursors: set[str] = set()
    for _ in range(_CODEX_MODEL_MAX_PAGES):
        params: dict[str, Any] = {"limit": _CODEX_MODEL_PAGE_SIZE}
        if cursor is not None:
            params["cursor"] = cursor
        try:
            result = await asyncio.wait_for(
                client.request("model/list", params),
                timeout=_CODEX_CHECK_TIMEOUT_S,
            )
        except Exception as exc:
            raise RuntimeError(f"model/list failed: {_exception_reason(exc)}") from exc
        page, next_cursor = _codex_model_page(result)
        for item in page:
            option = _normalize_codex_model_option(item)
            if option is None or option["hidden"]:
                continue
            model = option["model"]
            if model in seen_models:
                continue
            seen_models.add(model)
            options.append(option)
        if next_cursor is None:
            break
        if next_cursor in seen_cursors:
            raise RuntimeError("model/list returned a repeated cursor")
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    else:
        raise RuntimeError("model/list exceeded pagination limit")
    if not options:
        raise RuntimeError("model/list returned no usable models")
    return options


def _codex_model_page(result: Any) -> tuple[list[Any], str | None]:
    if not isinstance(result, dict):
        raise RuntimeError("model/list returned a non-object response")
    raw_models: Any = result.get("models")
    if raw_models is None:
        raw_models = result.get("items")
    if raw_models is None:
        raw_models = result.get("data")
    if isinstance(raw_models, dict):
        raw_models = raw_models.get("items") or raw_models.get("models")
    if not isinstance(raw_models, list):
        raise RuntimeError("model/list response has no models list")
    raw_cursor = (
        result.get("nextCursor")
        or result.get("nextPageToken")
        or result.get("next_page_token")
    )
    if raw_cursor is not None and (not isinstance(raw_cursor, str) or not raw_cursor):
        raise RuntimeError("model/list response has an invalid next cursor")
    return raw_models, raw_cursor


def _normalize_codex_model_option(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    model = item.get("model") or item.get("id") or item.get("value")
    if not isinstance(model, str) or not model:
        return None
    supported = item.get("supportedReasoningEfforts")
    if supported is None:
        supported = item.get("supported_reasoning_efforts")
    if supported is not None and not isinstance(supported, list):
        raise RuntimeError(f"model/list returned malformed efforts for {model}")
    normalized_efforts: list[str] | None = None
    if supported is not None:
        normalized_efforts = []
        for effort in supported:
            if isinstance(effort, str):
                value = effort
            elif isinstance(effort, dict):
                value = effort.get("reasoningEffort") or effort.get("effort")
            else:
                value = None
            if not isinstance(value, str) or not value:
                raise RuntimeError(f"model/list returned malformed effort for {model}")
            if value not in normalized_efforts:
                normalized_efforts.append(value)
    default_effort = item.get("defaultReasoningEffort") or item.get("default_reasoning_effort")
    if default_effort is not None and not isinstance(default_effort, str):
        raise RuntimeError(f"model/list returned malformed default effort for {model}")
    return {
        "model": model,
        "displayName": str(item.get("displayName") or item.get("name") or item.get("label") or model),
        "isDefault": bool(item.get("isDefault") or item.get("default")),
        "defaultReasoningEffort": default_effort,
        "supportedReasoningEfforts": normalized_efforts,
        "hidden": bool(item.get("hidden", False)),
    }


def _is_model_list_error(exc: BaseException) -> bool:
    return "model/list" in str(exc)


async def _check_claude_candidate(candidate: dict[str, str] | LaunchTarget) -> dict[str, Any]:
    target = _target_from_candidate(candidate)
    path = target.path
    source = target.source
    base = {"source": source, "path": path}
    if not Path(path).is_file():
        return {**base, "status": "missing", "reason": "file not found"}
    if not path_exists_for_launch(path):
        return {**base, "status": "failed", "reason": "not executable"}

    version = await _run_version(target.command(["--version"]))
    if version["status"] != "ok":
        return {**base, "status": "failed", "stage": "version", **version}
    help_result = await _run_version(target.command(["--help"]))
    if help_result["status"] != "ok":
        return {
            **base,
            "status": "failed",
            "stage": "help",
            "version": version.get("stdout"),
            "reason": help_result.get("reason"),
        }
    return {**base, "status": "ok", "version": version.get("stdout")}


def _check_claude_history() -> dict[str, Any]:
    source = "claude-agent-sdk"
    api = "list_sessions"
    try:
        sessions = _list_claude_sdk_sessions()
    except Exception as exc:
        return {
            "status": "unavailable",
            "source": source,
            "api": api,
            "reason": _exception_reason(exc),
        }
    return {
        "status": "ok" if sessions else "ok_empty",
        "source": source,
        "api": api,
        "sessionCount": len(sessions),
    }


def _list_claude_sdk_sessions() -> list[Any]:
    sdk = importlib.import_module("claude_agent_sdk")
    list_sessions = getattr(sdk, "list_sessions")
    return list(list_sessions())


async def _run_version(command: list[str]) -> dict[str, Any]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=_COMMAND_CHECK_TIMEOUT_S)
    except Exception as exc:
        return {"status": "failed", "reason": _exception_reason(exc)}
    out = stdout.decode(errors="replace").strip()
    err = stderr.decode(errors="replace").strip()
    if proc.returncode != 0:
        return {
            "status": "failed",
            "reason": f"exit {proc.returncode}",
            "stdout": out[:500],
            "stderr": err[:500],
        }
    return {"status": "ok", "stdout": out[:500], "stderr": err[:500]}


def _claude_candidate_paths() -> list[dict[str, str]]:
    if sys.platform == "win32":
        home = Path.home()
        appdata = os.environ.get("APPDATA", str(home / "AppData" / "Roaming"))
        return _dedupe_candidates(
            [
                {"source": "custom", "path": os.environ.get("CLAUDE_BIN", "")},
                {"source": "cli", "path": shutil.which("claude") or ""},
                *[
                    {"source": "cli", "path": str(home / ".local" / "bin" / name)}
                    for name in ("claude.exe", "claude.cmd", "claude.ps1")
                ],
                *[
                    {"source": "npm", "path": str(Path(appdata) / "npm" / name)}
                    for name in ("claude.cmd", "claude.ps1", "claude.exe")
                ],
                *[
                    {"source": "npm", "path": str(home / ".npm-global" / "bin" / name)}
                    for name in ("claude.cmd", "claude.ps1", "claude.exe")
                ],
                *[
                    {"source": "nvm", "path": str(Path("C:/nvm4w/nodejs") / name)}
                    for name in ("claude.cmd", "claude.ps1", "claude.exe")
                ],
                *[
                    {"source": "scoop", "path": str(home / "scoop" / "shims" / name)}
                    for name in ("claude.exe", "claude.cmd", "claude.ps1")
                ],
            ]
        )
    return _dedupe_candidates(
        [
            {"source": "custom", "path": os.environ.get("CLAUDE_BIN", "")},
            {"source": "cli", "path": shutil.which("claude") or ""},
            {"source": "cli", "path": str(Path.home() / ".npm-global" / "bin" / "claude")},
            {"source": "cli", "path": str(Path.home() / ".local" / "bin" / "claude")},
            {"source": "cli", "path": "/opt/homebrew/bin/claude"},
            {"source": "cli", "path": "/usr/local/bin/claude"},
        ]
    )


def _target_from_candidate(candidate: dict[str, str] | LaunchTarget) -> LaunchTarget:
    if isinstance(candidate, LaunchTarget):
        return candidate
    return launch_target(candidate["source"], candidate["path"])


def _dedupe_candidates(candidates: Iterable[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for candidate in candidates:
        path = candidate.get("path") or ""
        if not path or path in seen:
            continue
        seen.add(path)
        out.append(candidate)
    return out


def _selected_from_check(result: dict[str, Any]) -> dict[str, Any]:
    selected = {
        "source": result["source"],
        "path": result["path"],
    }
    if result.get("version"):
        selected["version"] = result["version"]
    return selected


def _exception_reason(exc: BaseException) -> str:
    if isinstance(exc, TimeoutError):
        return "timeout"
    return str(exc) or exc.__class__.__name__


def _now_iso() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


async def _noop() -> None:
    return None
