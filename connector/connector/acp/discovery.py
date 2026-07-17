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


_COMMAND_CHECK_TIMEOUT_S = 6.0
# Full auth/model probe is expensive (spawn + session/new). Discovery stays light.
_LIGHT_INIT_TIMEOUT_S = 10.0
_DEEP_PROBE_TIMEOUT_S = 12.0
_AUTH_METHOD_TIMEOUT_S = 4.0


async def discover_acp_manifest(
    manifest: AgentManifest,
    *,
    extra_candidate: str | None = None,
    deep_probe: bool = False,
) -> tuple[dict[str, Any], LaunchTarget | None]:
    """Locate binary and optionally deep-probe ACP initialize/session.

    Default is *light*: version check only (+ optional short initialize). Full
    session/new auth/model probe is deferred (deep_probe=True or first use).
    """
    candidates = _candidate_paths(manifest, extra_candidate=extra_candidate)
    checked: list[dict[str, Any]] = []
    for candidate in candidates:
        result = await _check_candidate(manifest, candidate)
        checked.append(result)
        if result["status"] != "ok":
            continue
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
            "authStatus": "unknown",
        }
        if result.get("versionUnverified"):
            report["versionUnverified"] = True
            report["warnings"] = ["version_check_failed"]
        if deep_probe:
            probe = await probe_acp_agent(manifest, target)
            report.update(probe)
        else:
            # Light: binary is present; auth/models filled on first real session
            # or background deep probe for active runtimes only.
            report["probeMode"] = "light"
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
    """Deep probe: initialize (+ optional session/new) for authStatus/models."""
    command = target.command(manifest.launch_args())
    client = AcpJsonRpcClient(command, env=dict(manifest.env) or None, cwd=None)
    probe: dict[str, Any] = {
        "authStatus": "unknown",
        "authMethods": [],
        "probeMode": "deep",
    }
    try:
        await asyncio.wait_for(client.start(), timeout=_LIGHT_INIT_TIMEOUT_S)
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
            timeout=_LIGHT_INIT_TIMEOUT_S,
        )
        auth_methods = init.get("authMethods") if isinstance(init.get("authMethods"), list) else []
        probe["authMethods"] = summarize_auth_methods(auth_methods)
        agent_caps = init.get("agentCapabilities") if isinstance(init.get("agentCapabilities"), dict) else {}
        if agent_caps.get("loadSession"):
            probe["history"] = "ok_empty"

        # Prefer initialize-only success: many agents are "ok enough" without session/new.
        # session/new is slow/unreliable for Cursor cold start.
        with tempfile.TemporaryDirectory(prefix="aa-acp-probe-") as tmp:
            session, auth_err = await _probe_session_new(client, tmp)
            if session is None and auth_err:
                await _try_authenticate(client, manifest, auth_methods)
                session, auth_err = await _probe_session_new(client, tmp)

            if session is None:
                if auth_err or probe["authMethods"]:
                    probe["authStatus"] = "required"
                    methods = probe["authMethods"]
                    names = ", ".join(
                        str(m.get("name") or m.get("id") or "") for m in methods
                    ) or "login"
                    probe["authHint"] = manifest.pre_auth_hint or (
                        f"{manifest.display_name} requires authentication ({names}). "
                        "Complete CLI login on the device, then refresh."
                    )
                    probe["execution"] = "ok"
                else:
                    # initialize worked — treat as attachable, auth unknown
                    probe["authStatus"] = "unknown"
                    probe["execution"] = "ok"
                return probe

            probe["authStatus"] = "ok"
            config_options = (
                session.get("configOptions") if isinstance(session.get("configOptions"), list) else []
            )
            config_options = [opt for opt in config_options if isinstance(opt, dict)]
            if config_options:
                probe["configOptions"] = config_options
                models = extract_model_options(config_options)
                modes = extract_mode_options(config_options)
                if models:
                    probe["modelOptions"] = models
                if modes:
                    probe["modeOptions"] = modes
            session_id = session.get("sessionId") or session.get("session_id")
            if isinstance(session_id, str) and session_id:
                await _best_effort_close_session(client, session_id)
            return probe
    except Exception as exc:
        logger.warning("ACP probe failed runtime={} error={}", manifest.id, exc)
        probe["authStatus"] = "unknown"
        probe["probeError"] = str(exc)
        # Binary was found; keep execution ok so UI can still attach and retry on use.
        probe["execution"] = "ok"
        return probe
    finally:
        try:
            await client.close()
        except Exception:
            pass


def _looks_like_auth_error(message: str) -> bool:
    text = (message or "").lower()
    tokens = (
        "auth",
        "login",
        "unauthor",
        "api key",
        "apikey",
        "credential",
        "not configured",
        "missing or not",
        "sign in",
        "signin",
        "token",
        "permission denied",
        "timeout",
        "timed out",
    )
    return any(tok in text for tok in tokens)


async def _probe_session_new(
    client: AcpJsonRpcClient,
    cwd: str,
) -> tuple[dict[str, Any] | None, bool]:
    """Return (session_result, auth_required)."""
    try:
        session = await client.request(
            "session/new",
            {"cwd": cwd, "mcpServers": []},
            timeout=_DEEP_PROBE_TIMEOUT_S,
        )
        return session if isinstance(session, dict) else {}, False
    except AcpJsonRpcError as exc:
        message = str(exc)
        if _looks_like_auth_error(message):
            return None, True
        logger.debug("ACP probe session/new failed non-auth: {}", exc)
        return None, False
    except Exception as exc:
        message = str(exc)
        if "timeout" in message.lower() or _looks_like_auth_error(message):
            return None, True
        logger.debug("ACP probe session/new failed: {}", exc)
        return None, False


async def _best_effort_close_session(client: AcpJsonRpcClient, session_id: str) -> None:
    for method in ("session/close", "session/cancel"):
        try:
            if method == "session/cancel":
                await client.notify(method, {"sessionId": session_id})
            else:
                await client.request(method, {"sessionId": session_id}, timeout=2.0)
            break
        except Exception:
            continue


async def _try_authenticate(
    client: AcpJsonRpcClient,
    manifest: AgentManifest,
    auth_methods: list[Any],
) -> None:
    """Try headless-only auth during deep probe. Never call interactive OAuth."""
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
    if manifest.command:
        found = shutil.which(manifest.command[0])
        if found:
            out.append({"source": "cli", "path": found})
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
                Path(local) / "cursor-agent" / "agent.cmd",
                Path(local) / "cursor-agent" / "agent.exe",
            ):
                out.append({"source": "common", "path": str(path)})
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
    if path_obj.is_absolute() and not path_obj.exists() and not shutil.which(path):
        return {**base, "status": "missing", "reason": "file not found"}
    if path_obj.is_absolute() and path_obj.is_file() and not path_exists_for_launch(path):
        return {**base, "status": "failed", "reason": "not executable"}

    target = launch_target(source, path)
    version_cmd = target.command(list(manifest.version_args))
    version = await _run_command(version_cmd)
    if version["status"] != "ok":
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
