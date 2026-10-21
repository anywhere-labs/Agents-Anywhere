"""Live probe: Codex `request_user_input` -> platform questionnaire round trip.

Drives the real Codex app-server through the connector SDK client using an
isolated CODEX_HOME, asks the model to call `request_user_input`, answers the
published questionnaire the way the platform would, and prints the round trip.

Manual run (requires Codex credentials in ``~/.codex/auth.json`` and spends one
small model turn). Set ``CODEX_PROBE_MODEL`` to pin a model; otherwise the
Codex default model is used:

    cd connector && .venv/bin/python tests/codex_question_probe.py
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

from test_codex_runtime import FakeHost

from connector.runtime_protocol import RuntimeConfig
from connector.runtimes.codex.runtime import CodexRuntime
from connector.runtimes.codex.sdk.client import sdk_client_from_config

PROBE_HOME = Path("/tmp/aa-question-probe-home")
PROBE_CWD = Path("/tmp/aa-question-probe-cwd")
SESSION_ID = "sess_probe"
PROMPT = (
    "在动手之前，先用 request_user_input 工具问我一个问题："
    "让我在 Python / Rust / Go 三个实现语言里选一个（带 header 和每个选项一句描述）。"
    "我回答之后，用一句话复述我选的选项，不要做其他事情。"
)


def prepare_home() -> None:
    source_auth = Path.home() / ".codex" / "auth.json"
    if not source_auth.exists():
        raise SystemExit("missing ~/.codex/auth.json")
    PROBE_HOME.mkdir(parents=True, exist_ok=True)
    PROBE_CWD.mkdir(parents=True, exist_ok=True)
    shutil.copy(source_auth, PROBE_HOME / "auth.json")
    lines = ['forced_login_method = "chatgpt"']
    model = os.environ.get("CODEX_PROBE_MODEL", "").strip()
    if model:
        lines.insert(0, f'model = "{model}"')
    lines += ["[features]", "default_mode_request_user_input = true"]
    (PROBE_HOME / "config.toml").write_text("\n".join(lines) + "\n", encoding="utf-8")


async def wait_for_input_request(host: FakeHost, timeout: float) -> Any | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for notice in host.notice_upserts:
            if notice.interaction_type == "input_request":
                return notice
        await asyncio.sleep(0.5)
    return None


async def wait_for_turn_end(host: FakeHost, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if host.turn_ends:
            return True
        await asyncio.sleep(0.5)
    return False


def item_text(item: Any) -> str | None:
    content = getattr(item, "content", None)
    if isinstance(content, Mapping):
        text = content.get("text")
    else:
        text = getattr(content, "text", None)
    return text.strip() if isinstance(text, str) and text.strip() else None


def agent_messages(host: FakeHost) -> list[str]:
    texts: list[str] = []
    for item in host.timeline_item_upserts:
        text = item_text(item)
        if text:
            texts.append(text)
    for sync in host.timeline_syncs:
        items = sync.get("items") if isinstance(sync, dict) else None
        if not isinstance(items, list):
            continue
        for item in items:
            text = item_text(item)
            if text:
                texts.append(text)
    return texts


async def main() -> int:
    prepare_home()
    host = FakeHost()
    config = RuntimeConfig(
        runtime="codex",
        revision=1,
        values={"codexHome": str(PROBE_HOME), "environment": {}},
    )
    client = sdk_client_from_config(config)
    runtime = CodexRuntime(config=config, host=host, client=client)

    await runtime.start()
    try:
        started = await runtime.create_and_start_session(
            SESSION_ID,
            PROMPT,
            cwd=str(PROBE_CWD),
        )
        print(f"[1] start session ok={started.ok} result={started.result}")

        notice = await wait_for_input_request(host, timeout=240)
        if notice is None:
            print("[2] NO input request notice observed")
            print(f"    notices={[n.interaction_type for n in host.notice_upserts]}")
            print(f"    agent messages={agent_messages(host)[-3:]}")
            return 2

        print(f"[2] input request notice: {notice.notice_id}")
        print(f"    source={notice.source}")
        print(f"    context.requestId={notice.context.get('requestId')}")
        action = notice.actions[0]
        for question in action["input"]["uiSchema"]["questions"]:
            print(
                "    question "
                f"id={question['id']} header={question.get('header')!r} "
                f"prompt={question['prompt']!r} allowCustom={question['allowCustom']}"
            )
            for option in question["options"]:
                print(f"      option {option['id']} {option['label']} ({option.get('description')})")

        answers = {
            question["id"]: {"optionIds": [question["options"][1]["id"]]}
            for question in action["input"]["uiSchema"]["questions"]
            if question["options"]
        }
        print(f"[3] answering with option ids: {answers}")
        responded = await runtime.respond_interaction(
            SESSION_ID,
            notice.notice_id,
            action["actionId"],
            {"requestId": notice.context.get("requestId"), "answers": answers},
        )
        print(f"[4] respond ok={responded.ok} decision={responded.result.get('decision')}")
        print(f"    response payload={responded.result.get('response')}")

        ended = await wait_for_turn_end(host, timeout=240)
        await asyncio.sleep(1.0)
        texts = agent_messages(host)
        print(f"[5] turn ended={ended}")
        print(f"    timeline item shapes={[(type(i).__name__, type(getattr(i, 'content', None)).__name__) for i in host.timeline_item_upserts][-6:]}")
        print(f"    timeline syncs={len(host.timeline_syncs)}")
        print(f"    final agent messages={texts[-3:]}")
        return 0 if ended and texts else 3
    finally:
        await runtime.stop()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
