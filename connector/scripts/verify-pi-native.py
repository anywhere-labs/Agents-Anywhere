"""Run the installed Pi CLI ↔ real ACP handoff against a local SSE model."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import tempfile
import threading
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from connector.runtime_protocol.workflows import RuntimeWorkflowRequest
from connector.runtimes.acp.profiles.pi.adapter import prepare_adapter
from connector.runtimes.acp.profiles.pi.history import read_history
from connector.runtimes.acp.profiles.pi.installation import resolve_local
from connector.runtimes.acp.profiles.pi.provider import PiProvider


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cache-root", type=Path, default=Path("/tmp/aa-pi-native-qa-cache/state")
    )
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="aa-pi-native-qa-"))
    workspace = root / "workspace"
    agent = root / "agent"
    extra = root / "extra-history"
    for path in (workspace, agent, extra, args.cache_root):
        path.mkdir(parents=True, exist_ok=True)
    requests, notifications = [], []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(request)
            users = [item for item in request["messages"] if item["role"] == "user"]
            latest = str(users[-1].get("content", "")) if users else ""
            after_user = request["messages"][
                max(
                    index
                    for index, item in enumerate(request["messages"])
                    if item["role"] == "user"
                )
                + 1 :
            ]
            needs_tool = "AA_WRITE" in latest and not any(
                item["role"] == "tool" for item in after_user
            )
            if needs_tool:
                denied = "DENY" in latest
                delta = {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_" + uuid4().hex,
                            "type": "function",
                            "function": {
                                "name": "write",
                                "arguments": json.dumps(
                                    {
                                        "path": str(
                                            workspace
                                            / (
                                                "denied.txt"
                                                if denied
                                                else "allowed.txt"
                                            )
                                        ),
                                        "content": "AA_NATIVE_WRITE_OK",
                                    }
                                ),
                            },
                        }
                    ],
                }
            else:
                delta = {"role": "assistant", "content": "PI_NATIVE_OK " + latest}
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            chunks = [
                {"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                {
                    "choices": [
                        {
                            "index": 0,
                            "delta": {},
                            "finish_reason": "tool_calls" if needs_tool else "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 8,
                        "completion_tokens": 4,
                        "total_tokens": 12,
                    },
                },
            ]
            for chunk in chunks:
                self.wfile.write(
                    (
                        "data: "
                        + json.dumps(
                            {
                                "id": "fixture",
                                "object": "chat.completion.chunk",
                                "created": 1,
                                "model": "fixture",
                                **chunk,
                            }
                        )
                        + "\n\n"
                    ).encode()
                )
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    (agent / "models.json").write_text(
        json.dumps(
            {
                "providers": {
                    "fixture": {
                        "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
                        "api": "openai-completions",
                        "apiKey": "fixture-local-only",
                        "models": [
                            {
                                "id": "fixture",
                                "name": "Fixture",
                                "reasoning": False,
                                "input": ["text"],
                                "contextWindow": 16384,
                                "maxTokens": 1024,
                                "cost": {
                                    "input": 0,
                                    "output": 0,
                                    "cacheRead": 0,
                                    "cacheWrite": 0,
                                },
                            }
                        ],
                    }
                }
            }
        )
    )
    (agent / "settings.json").write_text(
        json.dumps({"defaultProvider": "fixture", "defaultModel": "fixture"})
    )
    installed = resolve_local({})
    environment = {**os.environ, "PI_CODING_AGENT_DIR": str(agent)}
    source = extra / "native.jsonl"

    async def cli(text):
        result = await asyncio.to_thread(
            subprocess.run,
            [
                str(installed.node),
                str(installed.cli),
                "--print",
                "--no-extensions",
                "--session",
                str(source),
                text,
            ],
            cwd=workspace,
            env=environment,
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert result.returncode == 0, result.stderr[-1600:]
        assert "PI_NATIVE_OK" in result.stdout, result.stdout[-1600:]

    async def publish(_runtime, values, **kwargs):
        notifications.extend(values)

    host = SimpleNamespace(
        session_namespace=root.name,
        runtime_id="pi",
        runtime_kv=SimpleNamespace(path=args.cache_root / "runtime.json"),
        publish_runtime_notifications=publish,
    )
    provider = PiProvider()
    config = replace(
        await provider.validate_config(
            {
                "executionMode": "local",
                "cliPath": str(installed.cli),
                "agentDir": str(agent),
                "historyDirs": [str(extra)],
            }
        ),
        runtime_id="pi",
    )
    runtime = None
    results = {
        "root": str(root),
        "cli": str(installed.cli),
        "sdk": str(installed.sdk),
        "checks": {},
    }

    async def until(predicate):
        async with asyncio.timeout(90):
            while not predicate():
                await asyncio.sleep(0.03)

    async def resume(session_id):
        state = await runtime.get_session_state(session_id)
        request = RuntimeWorkflowRequest(
            "recover_session",
            {
                "sessionId": session_id,
                "operationId": uuid4().hex,
                "expectedGeneration": state.metadata["ownerGeneration"],
                "sourceRevision": state.metadata["sourceRevision"],
                "cliExited": True,
            },
        )
        result = await runtime.execute_workflow(request)
        while result.values["phase"] == "running":
            await asyncio.sleep(0.1)
            result = await runtime.execute_workflow(request)
        assert result.values["phase"] == "completed", result.values

    async def prompt(session_id, text, allow):
        message_id = uuid4().hex
        sending = asyncio.create_task(
            runtime.start_turn(
                session_id, native_id, text, client_message_id=message_id
            )
        )
        while not sending.done() or session_id in runtime.app.active_runs:
            for notice in await runtime.get_session_notices(session_id):
                if notice.status == "open":
                    action = next(
                        action
                        for action in notice.actions
                        if action["actionId"] == ("allow" if allow else "deny")
                    )
                    await runtime.respond_interaction(
                        session_id,
                        notice.notice_id,
                        action["actionId"],
                        {
                            "ownerGeneration": notice.metadata["ownerGeneration"],
                            "requestRevision": notice.metadata["requestRevision"],
                            "responseOperationId": uuid4().hex,
                        },
                    )
            await asyncio.sleep(0.03)
        result = await sending
        assert result.ok, result
        await until(lambda: session_id not in runtime.app.active_runs)
        await runtime._refresh_source(session_id)
        return message_id

    try:
        await cli("CLI_SEED")
        default_cli = await asyncio.to_thread(
            subprocess.run,
            [
                str(installed.node),
                str(installed.cli),
                "--print",
                "--no-extensions",
                "CLI_DEFAULT_SEED",
            ],
            cwd=workspace,
            env=environment,
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert default_cli.returncode == 0, default_cli.stderr[-1600:]
        history = read_history(source, (extra,))
        native_id = history.native_id
        before = {path.name: path.read_bytes() for path in agent.glob("*.json")}
        bytes_before = source.read_bytes()
        runtime = await provider.create_runtime(config, host)
        await runtime.start()
        sessions = await runtime.list_sessions()
        session_id = next(
            item.session_id
            for item in sessions
            if item.external_session_id == native_id
        )
        default_session = next(
            item for item in sessions if item.external_session_id != native_id
        )
        assert not runtime.app.contexts and not runtime.environment_ready
        assert source.read_bytes() == bytes_before
        assert before == {path.name: path.read_bytes() for path in agent.glob("*.json")}
        results["checks"]["readOnlyBrowsing"] = True
        await resume(default_session.session_id)
        default_state = await runtime.get_session_state(default_session.session_id)
        await runtime.execute_workflow(
            RuntimeWorkflowRequest(
                "close_session",
                {
                    "sessionId": default_session.session_id,
                    "ownerGeneration": default_state.metadata["ownerGeneration"],
                    "closeOperationId": uuid4().hex,
                },
            )
        )
        results["checks"]["defaultDirectoryResume"] = True
        await resume(session_id)
        assert read_history(source, (extra,)).native_id == native_id
        results["checks"]["resumeSameNativeSession"] = True
        await prompt(session_id, "AA_WRITE_ALLOW", True)
        assert (workspace / "allowed.txt").read_text() == "AA_NATIVE_WRITE_OK"
        assert "CLI_SEED" in str(requests[-1]["messages"])
        results["checks"]["nativeContextAndAllowedWrite"] = True
        await prompt(session_id, "AA_WRITE_DENY", False)
        assert not (workspace / "denied.txt").exists()
        results["checks"]["deniedToolDidNotExecute"] = True
        reload_result = await runtime.execute_command(
            session_id, "reload", external_session_id=native_id
        )
        assert reload_result.ok, reload_result
        await prompt(session_id, "AA_WRITE_DENY_AFTER_RELOAD", False)
        assert not (workspace / "denied.txt").exists()
        results["checks"]["guardAfterReload"] = True
        state = await runtime.get_session_state(session_id)
        await runtime.execute_workflow(
            RuntimeWorkflowRequest(
                "close_session",
                {
                    "sessionId": session_id,
                    "ownerGeneration": state.metadata["ownerGeneration"],
                    "closeOperationId": uuid4().hex,
                },
            )
        )
        assert session_id not in runtime.app.sessions
        await cli("CLI_RETURN")
        assert "AA_WRITE_ALLOW" in str(requests[-1]["messages"])
        results["checks"]["cliReturnSawAaHistory"] = True
        await runtime.scan()
        await resume(session_id)
        await prompt(session_id, "AA_WRITE_DENY_AFTER_RESUME", False)
        assert not (workspace / "denied.txt").exists()
        results["checks"]["guardAfterResume"] = True
        snapshots = [await runtime.get_session_snapshot(session_id) for _ in range(2)]
        assert [item.id for item in snapshots[0].items] == [
            item.id for item in snapshots[1].items
        ]
        assert len({item.id for item in snapshots[0].items}) == len(snapshots[0].items)
        results["checks"]["stableTimeline"] = True
        entry = {
            "type": "custom",
            "customType": "external-probe",
            "id": uuid4().hex[:8],
            "parentId": history.entries[-1].get("id"),
            "timestamp": "2026-10-30T00:00:00Z",
            "data": {"external": True},
        }
        with source.open("a") as output:
            output.write(json.dumps(entry) + "\n")
        await runtime._check_live_sources()
        assert session_id not in runtime.app.sessions
        assert (
            runtime.app.store.require("pi_native_failure", session_id)["code"]
            == "pi_source_conflict"
        )
        results["checks"]["externalConflictStoppedExecution"] = True
        assert before["models.json"] == (agent / "models.json").read_bytes()
        assert before["settings.json"] == (agent / "settings.json").read_bytes()
        results["checks"]["existingConfigurationPreserved"] = True
        report = json.loads((runtime.app.root / "execution-source.json").read_text())
        assert report["installation"]["sdk"] == str(installed.sdk)
        results["checks"]["boundInstalledSdk"] = True
        original_adapter = (
            Path(runtime.launch.arguments[0]).parents[1]
            / "node_modules/@openma/pi-acp/dist/bin.js"
        )
        missing_sdk_adapter, _ = await asyncio.to_thread(
            prepare_adapter,
            original_adapter,
            root / "missing-sdk",
            root / "negative-adapter",
        )
        no_fallback = await asyncio.to_thread(
            subprocess.run,
            [str(installed.node), str(missing_sdk_adapter), "--version"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert no_fallback.returncode != 0 and "missing-sdk" in no_fallback.stderr
        results["checks"]["missingSelectedSdkDoesNotFallback"] = True
        before_restart_requests = len(requests)
        await runtime.stop()
        runtime = await provider.create_runtime(config, host)
        await runtime.start()
        assert len(requests) == before_restart_requests
        await resume(session_id)
        await prompt(session_id, "AA_WRITE_DENY_AFTER_RESTART", False)
        assert not (workspace / "denied.txt").exists()
        results["checks"]["runtimeRestartResumeWithoutReplay"] = True
        await runtime.stop()
        model_bytes = (agent / "models.json").read_bytes()
        missing_auth = json.loads(model_bytes)
        missing_auth["providers"]["fixture"].pop("apiKey", None)
        (agent / "models.json").write_text(json.dumps(missing_auth))
        runtime = await provider.create_runtime(config, host)
        await runtime.start()
        state = await runtime.get_session_state(session_id)
        auth_request = RuntimeWorkflowRequest(
            "recover_session",
            {
                "sessionId": session_id,
                "operationId": uuid4().hex,
                "expectedGeneration": state.metadata["ownerGeneration"],
                "sourceRevision": state.metadata["sourceRevision"],
                "cliExited": True,
            },
        )
        try:
            response = await runtime.execute_workflow(auth_request)
            while response.values["phase"] == "running":
                await asyncio.sleep(0.1)
                response = await runtime.execute_workflow(auth_request)
            assert response.values["phase"] == "rejected", response.values
            assert response.values["failure"]["code"] in {
                "pi_authentication_required",
                "pi_model_unavailable",
            }, response.values
            assert session_id not in runtime.app.sessions
            assert (await runtime.get_session_snapshot(session_id)).items
            results["checks"][
                "authenticationFailureKeepsBrowsingWithoutAcceptingMessages"
            ] = True
        finally:
            (agent / "models.json").write_bytes(model_bytes)
        results["modelRequests"] = len(requests)
        results["nativeSessionId"] = native_id
        results["timelineItems"] = len(snapshots[0].items)
        print(json.dumps(results, ensure_ascii=False, indent=2))
    finally:
        if runtime:
            await runtime.stop()
        server.shutdown()
        (root / "results.json").write_text(
            json.dumps(results, ensure_ascii=False, indent=2)
        )


if __name__ == "__main__":
    asyncio.run(main())
