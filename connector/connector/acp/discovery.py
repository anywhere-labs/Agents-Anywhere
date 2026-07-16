from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

from connector.acp.config_options import (
    extract_mode_options,
    extract_model_options,
    order_headless_auth_method_ids,
    summarize_auth_methods,
)
from connector.acp.manifest import AgentManifest
from connector.acp.rpc import AcpJsonRpcClient, AcpJsonRpcError
from connector.launch import LaunchTarget, launch_target, path_exists_for_launch
from connector.logging import logger


_COMMAND_CHECK_TIMEOUT_S = 8.0
_AUTH_PROBE_TIMEOUT_S = 12.0
_AUTH_METHOD_TIMEOUT_S = 4.0


async def discover_acp_manifest(
    manifest: AgentManifest,
    *,
    extra_candidate: str | None = None,
) -> tuple[dict[str, Any], LaunchTarget | None]:
    candidates = _candidate_paths(manifest, extra_candidate=extra_candidate)
    checked: list[dict[str, Any]] = []
    for candidate in candidates:
        result = await _check_candidate(manifest, candidate)
        checked.append(result)
        if result["status"] == "ok":
            target = launch_target(result["source"], result["path"])
            report: dict[str, Any] = {
                "history": "unavailable",
                "execution": "ok",
                "transport": "acp",
                "displayName": manifest.display_name,
                "selected": {
                    "source": result["source"],
                    "path": result["path"],
                    "version": result.get("version"),
                },
                "checked": checked,
                "authHint": manifest.pre_auth_hint,
            }
            if result.get("versionUnverified"):
                report["versionUnverified"] = True
                report["warnings"] = ["version_check_failed"]
            # Probe ACP auth + optional model options (best-effort, short timeouts).
            probe = await probe_acp_agent(manifest, target)
            report.update(probe)
            return report, target
    return (
        {
            "history": "unavailable",
            "execution": "unavailable",
            "transport": "acp",
            "displayName": manifest.display_name,
            "error": {
                "code": f"{manifest.id}_unavailable",
                "message": (
                    f"{manifest.display_name} is unavailable. "
                    f"{manifest.pre_auth_hint or 'Install the CLI and ensure it is on PATH.'}"
                ),
            },
            "checked": checked,
            "authHint": manifest.pre_auth_hint,
            "authStatus": "unknown",
        },
        None,
    )


async def probe_acp_agent(manifest: AgentManifest, target: LaunchTarget) -> dict[str, Any]:
    """Probe initialize/auth/session/new to report authStatus and live model options."""
    command = target.command(manifest.launch_args())
    client = AcpJsonRpcClient(command, env=dict(manifest.env) or None, cwd=None)
    probe: dict[str, Any] = {
        "authStatus": "unknown",
        "authMethods": [],
    }
    try:
        await asyncio.wait_for(client.start(), timeout=_AUTH_PROBE_TIMEOUT_S)
        init = await client.request(
            "initialize",
            {
                "protocolVersion": 1,
                "clientCapabilities": {
                    **manifest.client_capabilities(),
                    "session": {"configOptions": {"boolean": {}}},
                },
                "clientInfo": {"name": "agents-anywhere-discovery", "version": "0.1"},
            },
            timeout=_AUTH_PROBE_TIMEOUT_S,
        )
        auth_methods = init.get("authMethods") if isinstance(init.get("authMethods"), list) else []
        probe["authMethods"] = summarize_auth_methods(auth_methods)
        agent_caps = init.get("agentCapabilities") if isinstance(init.get("agentCapabilities"), dict) else {}
        if agent_caps.get("loadSession"):
            probe["history"] = "ok_empty"

        # Attempt non-interactive auth first (cached_token style), then any advertised methods quickly.
        await _try_authenticate(client, manifest, auth_methods)

        # session/new is the source of truth for auth + configOptions/models.
        with tempfile.TemporaryDirectory(prefix="aa-acp-probe-") as tmp:
            try:
                session = await client.request(
                    "session/new",
                    {"cwd": tmp, "mcpServers": []},
                    timeout=_AUTH_PROBE_TIMEOUT_S,
                )
            except AcpJsonRpcError as exc:
                message = str(exc).lower()
                if "auth" in message or "login" in message or "unauthor" in message:
                    probe["authStatus"] = "required"
                    methods = probe["authMethods"]
                    names = ", ".join(
                        str(m.get("name") or m.get("id") or "") for m in methods
                    ) or "interactive login"
                    probe["authHint"] = (
                        f"{manifest.display_name} requires ACP authentication "
                        f"({names}). Terminal TUI login may not satisfy headless ACP mode."
                    )
                    # Keep execution ok so the agent can stay attached; UI shows auth badge.
                    probe["execution"] = "ok"
                else:
                    probe["authStatus"] = "unknown"
                    probe["probeError"] = str(exc)
                return probe

        probe["authStatus"] = "ok"
        config_options = session.get("configOptions") if isinstance(session.get("configOptions"), list) else []
        config_options = [opt for opt in config_options if isinstance(opt, dict)]
        if config_options:
            probe["configOptions"] = config_options
            models = extract_model_options(config_options)
            modes = extract_mode_options(config_options)
            if models:
                probe["modelOptions"] = models
            if modes:
                probe["modeOptions"] = modes
        # Best-effort close session if supported
        session_id = session.get("sessionId") or session.get("session_id")
        if isinstance(session_id, str) and session_id:
            for method in ("session/close", "session/cancel"):
                try:
                    if method == "session/cancel":
                        await client.notify(method, {"sessionId": session_id})
                    else:
                        await client.request(method, {"sessionId": session_id}, timeout=3.0)
                    break
                except Exception:
                    continue
        return probe
    except Exception as exc:
        logger.warning("ACP probe failed runtime={} error={}", manifest.id, exc)
        probe["authStatus"] = "unknown"
        probe["probeError"] = str(exc)
        return probe
    finally:
        try:
            await client.close()
        except Exception:
            pass


async def _try_authenticate(
    client: AcpJsonRpcClient,
    manifest: AgentManifest,
    auth_methods: list[Any],
) -> None:
    """Try headless-only auth during discovery. Never call interactive OAuth methods.

    Interactive methods (CodeBuddy iOA/external/internal/selfhosted, etc.) open a
    browser as soon as authenticate is invoked. Discovery re-runs on every connector
    reconnect, so trying them causes a browser-tab spam loop.
    """
    methods = [m for m in auth_methods if isinstance(m, dict)]
    if not methods:
        return
    method_ids = [str(m.get("id") or m.get("methodId") or "") for m in methods]
    method_ids = [mid for mid in method_ids if mid]
    ordered = order_headless_auth_method_ids(
        method_ids,
        preferred=list(manifest.preferred_auth_method_ids),
    )
    if not ordered:
        # Agent only exposes interactive methods — leave authStatus to session/new probe.
        logger.debug(
            "ACP discovery skip interactive auth runtime={} methods={}",
            manifest.id,
            method_ids,
        )
        return
    for mid in ordered:
        try:
            await client.request(
                "authenticate",
                {"methodId": mid, "_meta": {"headless": True}},
                timeout=_AUTH_METHOD_TIMEOUT_S,
            )
            logger.info("ACP discovery authenticated runtime={} method={}", manifest.id, mid)
            return
        except Exception:
            continue


def _candidate_paths(
    manifest: AgentManifest,
    *,
    extra_candidate: str | None = None,
) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    if extra_candidate:
        out.append({"source": "custom", "path": os.path.expandvars(os.path.expanduser(extra_candidate))})
    for env_name in manifest.env_paths:
        value = os.environ.get(env_name)
        if value:
            out.append({"source": "env", "path": os.path.expandvars(os.path.expanduser(value))})
    for name in manifest.which:
        found = shutil.which(name)
        if found:
            out.append({"source": "cli", "path": found})
    # Also try first command token as bare name on PATH
    if manifest.command:
        found = shutil.which(manifest.command[0])
        if found:
            out.append({"source": "cli", "path": found})
    # Windows common shims (npm global installs end with .cmd / .ps1)
    if sys.platform == "win32":
        home = Path.home()
        appdata = os.environ.get("APPDATA", str(home / "AppData" / "Roaming"))
        local = os.environ.get("LOCALAPPDATA", str(home / "AppData" / "Local"))
        names = list(manifest.which) or ([manifest.command[0]] if manifest.command else [])
        for name in names:
            for path in (
                home / ".local" / "bin" / f"{name}.exe",
                home / ".local" / "bin" / f"{name}.cmd",
                Path(appdata) / "npm" / name,
                Path(appdata) / "npm" / f"{name}.cmd",
                Path(appdata) / "npm" / f"{name}.ps1",
                Path(local) / "Programs" / name / f"{name}.exe",
            ):
                out.append({"source": "common", "path": str(path)})
            # Also resolve via where.exe for .cmd that shutil.which may miss
            found = shutil.which(name) or shutil.which(f"{name}.cmd")
            if found:
                out.append({"source": "cli", "path": found})
    return _dedupe(out)


async def _check_candidate(manifest: AgentManifest, candidate: dict[str, str]) -> dict[str, Any]:
    path = candidate["path"]
    source = candidate["source"]
    base: dict[str, Any] = {"source": source, "path": path}
    if not path:
        return {**base, "status": "missing", "reason": "empty path"}
    path_obj = Path(path)
    # bare command names from which() are files; allow non-absolute for which results
    if path_obj.is_absolute() and not path_obj.exists() and not shutil.which(path):
        return {**base, "status": "missing", "reason": "file not found"}
    if path_obj.is_absolute() and path_obj.is_file() and not path_exists_for_launch(path):
        return {**base, "status": "failed", "reason": "not executable"}

    target = launch_target(source, path)
    version_cmd = target.command(list(manifest.version_args))
    version = await _run_command(version_cmd)
    if version["status"] != "ok":
        # Binary exists but --version failed: attachable yet unverified (UI can warn).
        if path_obj.is_file() or shutil.which(path):
            return {
                **base,
                "status": "ok",
                "version": None,
                "versionUnverified": True,
                "versionNote": version.get("reason") or version.get("stderr"),
            }
        return {**base, "status": "failed", "stage": "version", **version}
    return {**base, "status": "ok", "version": version.get("stdout"), "versionUnverified": False}


async def _run_command(command: list[str]) -> dict[str, Any]:
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(process.communicate(), timeout=_COMMAND_CHECK_TIMEOUT_S)
        except TimeoutError:
            process.kill()
            await process.wait()
            return {"status": "failed", "reason": "timeout"}
        stdout = stdout_b.decode(errors="replace").strip()
        stderr = stderr_b.decode(errors="replace").strip()
        if process.returncode != 0:
            return {
                "status": "failed",
                "reason": f"exit {process.returncode}",
                "stdout": stdout[:500],
                "stderr": stderr[:500],
            }
        return {"status": "ok", "stdout": (stdout or stderr)[:200]}
    except FileNotFoundError:
        return {"status": "missing", "reason": "file not found"}
    except Exception as exc:
        logger.exception("ACP version check failed command={}", command)
        return {"status": "failed", "reason": str(exc)}


def _dedupe(candidates: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for item in candidates:
        path = item.get("path") or ""
        if not path or path in seen:
            continue
        seen.add(path)
        out.append(item)
    return out
