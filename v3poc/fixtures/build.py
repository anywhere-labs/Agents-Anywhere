#!/usr/bin/env python3
"""Generate the v3 PoC fixtures (workspace.json, session-demo.json) shared by the web and iOS demos.

Run: python3 -I v3poc/fixtures/build.py

The shapes follow v3poc/protocol/timeline.ts (modelled on Effi Cloud's cloud.v1.Conversations).

session-demo.json = { snapshot, script, reply, account }.
  snapshot   the first WatchEvent (type "snapshot").
  script     plays after the session opens.
  reply      plays whenever the demo composer sends (after the replayer adds the user message itself).

Script steps (fixture-only; a real Connector produces the watch stream itself):
  {"wait": ms, "event": WatchEvent}
        push it as is. Items get `seq` from the replayer: the first time an id appears it takes the next position
        (after the snapshot's last seq); later pushes of the same id keep it. Fixture items therefore omit `seq`.
        The same goes for `created_at`: the replayer sets it to the current time when an id first appears and keeps
        it afterwards, so elapsed times ("运行中 · 7 秒", "用时 …") are real rather than the fixture's fixed instant.
  {"wait": ms, "stream": {"message": AssistantMessage, "cps": n, "interval": 333}}
        push the item whole every `interval` ms (Effi Cloud coalesces at 333 ms) while its text grows at `cps`
        characters per second: parts[0].text for text/thinking, parts[0].output (a string) for tools. The last push
        has the full text and the message's own `done`.
  {"wait": ms, "until": "answer", "request_id": id}
        pause until someone answers that request. The replayer then pushes a control with the request moved from
        `pending` to `answered` (by = account name, device = "iPhone" / "Web"); the script continues with the rest.
        Every later scripted `control` event keeps those `answered` records (the replayer copies them in): a real
        Connector pushes the whole control, recent answers included, so a fixture control must not drop them.
In `reply`: "$TURN" = the id of the user message just sent, "$X" inside ids = a fresh token per send.
"""

import copy
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
T0 = "2026-11-17T09:30:00Z"
ACCOUNT = {"name": "t4wefan", "email": "t4wefan@example.com"}
CWD = "~/code/github/Agents-Anywhere"

workspace = {
    "account": ACCOUNT,
    "devices": [
        {"id": "dev-mbp", "name": "t4wefan 的 MacBook Pro", "presence": "online", "platform": "macos"},
        {"id": "dev-box", "name": "devbox-sh", "presence": "online", "platform": "linux"},
        {"id": "dev-win", "name": "office-win", "presence": "offline", "platform": "windows"},
    ],
    "projects": [
        {"device_id": "dev-mbp", "cwd": CWD, "name": "Agents-Anywhere"},
        {"device_id": "dev-mbp", "cwd": "~/code/local/effi-evo", "name": "effi-evo"},
        {"device_id": "dev-box", "cwd": "/srv/AA-landingpage", "name": "AA-landingpage"},
    ],
    "sessions": [
        {"id": "s-unread", "title": "修复已读后又变回未读", "agent": "codex", "device_id": "dev-mbp", "cwd": CWD, "state": "running", "unread": False, "pinned": True, "updated_at": "2026-11-17T09:30:00Z"},
        {"id": "s-release", "title": "2.1.0 发布说明定稿", "agent": "claude", "device_id": "dev-mbp", "cwd": CWD, "state": "idle", "unread": False, "pinned": True, "updated_at": "2026-11-16T15:12:00Z"},
        {"id": "s-meshcall", "title": "MeshCall 0.4 升级评估", "agent": "claude", "device_id": "dev-mbp", "cwd": "~/code/local/effi-evo", "state": "waiting", "unread": True, "pinned": False, "updated_at": "2026-11-17T08:58:00Z"},
        {"id": "s-ios-glass", "title": "iOS 液态玻璃输入框动画", "agent": "codex", "device_id": "dev-mbp", "cwd": CWD, "state": "idle", "unread": True, "pinned": False, "updated_at": "2026-11-17T07:41:00Z"},
        {"id": "s-sponsors", "title": "落地页赞助商栏位", "agent": "dsh", "device_id": "dev-box", "cwd": "/srv/AA-landingpage", "state": "idle", "unread": False, "pinned": False, "updated_at": "2026-11-16T11:03:00Z"},
        {"id": "s-usage", "title": "用量报表 SQL 下推", "agent": "codex", "device_id": "dev-box", "cwd": "/srv/AA-landingpage", "state": "error", "unread": False, "pinned": False, "updated_at": "2026-11-15T20:44:00Z"},
        {"id": "s-cloud", "title": "Effi Cloud 设备页改版", "agent": "claude", "device_id": "dev-mbp", "cwd": "~/code/local/effi-evo", "state": "idle", "unread": False, "pinned": False, "updated_at": "2026-11-14T10:20:00Z"},
        {"id": "s-misc", "title": "解释一下 Alembic 迁移编号", "agent": "claude", "device_id": "dev-win", "cwd": "C:\\work\\scratch", "state": "idle", "unread": False, "pinned": False, "updated_at": "2026-11-12T09:00:00Z"},
    ],
}

CONFIG = [
    {"id": "model", "name": "模型", "category": "model", "current": "gpt-5.5-codex",
     "options": [{"value": "gpt-5.5-codex", "name": "GPT-5.5 Codex"}, {"value": "gpt-5.5", "name": "GPT-5.5"}, {"value": "gpt-5.5-mini", "name": "GPT-5.5 mini"}]},
    {"id": "mode", "name": "权限", "category": "mode", "current": "on-request",
     "options": [{"value": "read-only", "name": "只读"}, {"value": "on-request", "name": "按需批准", "description": "读文件自动，执行命令前询问"},
                 {"value": "full-access", "name": "完全访问"}]},
    {"id": "effort", "name": "推理强度", "category": "thought_level", "current": "high",
     "options": [{"value": "low", "name": "低"}, {"value": "medium", "name": "中"}, {"value": "high", "name": "高"}]},
]

SESSION = {
    "id": "s-unread",
    "title": "修复已读后又变回未读",
    "agent": "codex",
    "device": {"id": "dev-mbp", "name": "t4wefan 的 MacBook Pro"},
    "cwd": CWD,
    "branch": "fix/be/flaky-unread-rearm",
    "created_at": "2026-11-17T09:12:00Z",
    "updated_at": T0,
    "message_count": 7,
    "config": CONFIG,
}


def control(state, pending=(), answered=(), used=61_400):
    return {"state": state, "steer": "native", "pending": list(pending), "queued": [], "answered": list(answered),
            "usage": {"used": used, "size": 272_000, "model": "gpt-5.5-codex", "updated_at": T0},
            "capabilities": {"compact": True}}


def user(id, seq, text, at, attachments=()):
    parts = ([{"type": "text", "text": text}] if text else []) + list(attachments)
    return {"id": id, "role": "user", "created_at": at, "seq": seq, "done": True, "rewindable": True, "parts": parts}


def item(id, turn, part, at=T0, done=True, seq=None, **extra):
    m = {"id": id, "role": "assistant", "turn_id": turn, "created_at": at, "done": done, "parts": [part], **extra}
    if seq is not None:
        m["seq"] = seq
    return m


def tool(id, title, kind, status, input=None, output=None, **extra):
    p = {"type": "tool", "id": id, "title": title, "kind": kind, "status": status}
    if input is not None:
        p["input"] = input
    if output is not None:
        p["output"] = output
    p.update(extra)
    return p


ANSWER_1 = """问题出在**两条写入路径的先后顺序**上：

1. 客户端调用 `POST /sessions/{id}/read` 时，会把 `last_read_seq` 写成当前的 `latest_seq`。
2. 但 Timeline 刷写是异步批量提交的。刷写线程拿到的 `latest_seq` 可能比已读请求**更早**读出，提交时又把 `unread` 重新置成 `true`。

```python
# services/session_read_state.py
async def mark_read(self, session_id: str, seq: int) -> None:
    state = await self.store.get(session_id)
    state.last_read_seq = max(state.last_read_seq, seq)
    state.unread = state.latest_seq > state.last_read_seq   # ← 读到的 latest_seq 可能已过期
    await self.store.put(state)
```

| 时刻 | 刷写线程 | 已读请求 |
| --- | --- | --- |
| t0 | 读到 `latest_seq = 41` | |
| t1 | | 写入 `last_read_seq = 42` |
| t2 | 提交 `unread = true` → 重新变回未读 | |

修复思路：把未读判断改成**数据库里的一条条件更新**，不在应用层先读后写。要我直接改吗？"""

OLD_MARK = """    async def mark_read(self, session_id: str, seq: int) -> None:
        state = await self.store.get(session_id)
        state.last_read_seq = max(state.last_read_seq, seq)
        state.unread = state.latest_seq > state.last_read_seq
        await self.store.put(state)
"""
NEW_MARK = """    async def mark_read(self, session_id: str, seq: int) -> None:
        await self.store.execute(
            \"\"\"
            UPDATE session_read_state
               SET last_read_seq = GREATEST(last_read_seq, :seq),
                   unread = latest_seq > GREATEST(last_read_seq, :seq)
             WHERE session_id = :session_id
            \"\"\",
            {"seq": seq, "session_id": session_id},
        )
"""
NEW_TEST = """import pytest


@pytest.mark.asyncio
async def test_read_is_not_rearmed_by_a_stale_flush(read_state, timeline):
    await timeline.append("s1", seq=41)
    stale = await timeline.begin_flush("s1")          # reads latest_seq = 41
    await read_state.mark_read("s1", seq=42)
    await stale.commit()

    state = await read_state.get("s1")
    assert state.unread is False
"""

FAIL_OUTPUT = """============================= test session starts ==============================
collected 7 items

tests/test_session_read_state.py ......F                                  [100%]

=================================== FAILURES ===================================
__________________ test_read_is_not_rearmed_by_a_stale_flush __________________
E   asyncpg.exceptions.UndefinedTableError: relation "session_read_state" does not exist
=========================== short test summary info ============================
FAILED tests/test_session_read_state.py::test_read_is_not_rearmed_by_a_stale_flush
1 failed, 6 passed in 2.41s
"""

PASS_OUTPUT = """============================= test session starts ==============================
collected 7 items

tests/test_session_read_state.py .......                                  [100%]

============================== 7 passed in 2.87s ===============================
"""

DOCKER_OUTPUT = "[+] Running 1/1\n ✔ Container aa-postgres  Started\n"

FINAL = """修好了，测试也补上了。

**改了什么**

- `mark_read` 不再「先读后写」，改成一条带 `GREATEST` 的条件更新，刷写线程和已读请求谁先提交都不会把已读状态改回去。
- 新增 `test_read_is_not_rearmed_by_a_stale_flush`，用一次「过期的刷写」复现原来的竞态。

| 检查 | 结果 |
| --- | --- |
| `pytest tests/test_session_read_state.py` | 7 passed |
| `ruff check` | 通过 |

> 还没做：真机上反复切换会话验证未读点，这需要在 iOS 上手动点一遍。"""

REASONING = "用户要求修复并补测试。先确认 session_read_state 的读写都经过 store，再看测试夹具里有没有可以手动控制刷写时机的 timeline。条件更新用 GREATEST 可以一次完成，不需要加锁。测试需要本地 postgres。"

# ── history (snapshot) ──────────────────────────────────────────────────────────────────────────────────────────

U1, U2 = "m-u1", "m-u2"
history = [
    user(U1, 0, "看一下 server 里会话未读标记的逻辑，为什么有时候点开会话之后，过一会儿又变回未读了？", "2026-11-17T09:12:00Z"),
    item("m-a1", U1, {"type": "thinking", "text": "先找未读状态在哪里写入：已读接口一处，Timeline 刷写一处。两处如果都是先读后写，就可能互相覆盖。"},
         at="2026-11-17T09:12:03Z", seq=1),
    item("m-a2", U1, tool("call-1", "rg -n \"unread\" server/agent_server/services", "search", "completed",
                          input={"command": "rg -n \"unread\" server/agent_server/services", "cwd": CWD},
                          output="services/session_read_state.py:15:        state.unread = state.latest_seq > state.last_read_seq\nservices/timeline_flush.py:88:            state.unread = True\nservices/timeline_flush.py:91:        await self.read_state.put(state)"),
         at="2026-11-17T09:12:05Z", seq=2),
    item("m-a3", U1, tool("call-2", "Read server/agent_server/services/timeline_flush.py (70–95)", "read", "completed",
                          input={"path": "server/agent_server/services/timeline_flush.py", "line": 70, "limit": 26},
                          output="    async def _commit(self, batch):\n        state = await self.read_state.get(batch.session_id)\n        state.latest_seq = batch.last_seq\n        if state.latest_seq > state.last_read_seq:\n            state.unread = True\n        await self.read_state.put(state)",
                          locations=[{"path": "server/agent_server/services/timeline_flush.py", "line": 70}]),
         at="2026-11-17T09:12:06Z", seq=3),
    item("m-a4", U1, {"type": "text", "text": ANSWER_1}, at="2026-11-17T09:13:10Z", seq=4),
    user(U2, 5, "改吧，顺便补一个能复现这个竞态的测试。", "2026-11-17T09:29:58Z",
         attachments=[{"type": "image", "path": "/home/dev/.aa/attachments/s-unread/k3/未读点截图.png", "name": "未读点截图.png", "mime": "image/png", "size": 182_311}]),
]

snapshot = {"type": "snapshot", "session": SESSION, "messages": history, "has_more": True, "control": control("running")}

# ── live script ─────────────────────────────────────────────────────────────────────────────────────────────────

PLAN_STEPS = ["把 mark_read 改成条件更新", "补一个复现竞态的测试", "跑测试并检查 lint"]


def plan(statuses):
    return {"type": "plan", "entries": [{"content": c, "status": s} for c, s in zip(PLAN_STEPS, statuses)]}


REQUEST = {"request_id": "req-1", "message_id": "m-b8", "tool_call_id": "call-8", "title": "docker compose -f docker/docker-compose.local.yml up -d postgres",
           "options": [{"id": "allow", "name": "允许", "kind": "allow_once"}, {"id": "always", "name": "本会话都允许", "kind": "allow_always"},
                       {"id": "reject", "name": "拒绝", "kind": "reject_once"}]}
DOCKER_INPUT = {"command": "docker compose -f docker/docker-compose.local.yml up -d postgres", "cwd": CWD}
PYTEST_INPUT = {"command": "uv run pytest tests/test_session_read_state.py -q", "cwd": CWD + "/server"}
SESSION_PATH = "server/agent_server/services/session_read_state.py"
TEST_PATH = "server/tests/test_session_read_state.py"


def ev(message):
    return {"type": "message", "message": message}


script = [
    {"wait": 600, "stream": {"message": item("m-b1", U2, {"type": "thinking", "text": REASONING}), "cps": 70}},
    {"wait": 200, "event": ev(item("m-b2", U2, plan(["in_progress", "pending", "pending"]), done=False))},
    {"wait": 400, "event": ev(item("m-b3", U2, tool("call-3", f"Read {SESSION_PATH}", "read", "in_progress", input={"path": SESSION_PATH}), done=False))},
    {"wait": 450, "event": ev(item("m-b3", U2, tool("call-3", f"Read {SESSION_PATH}", "read", "completed", input={"path": SESSION_PATH},
                                                     output="class SessionReadState:\n    async def mark_read(self, session_id: str, seq: int) -> None:\n        ...",
                                                     locations=[{"path": SESSION_PATH, "line": 12}])))},
    {"wait": 600, "event": ev(item("m-b4", U2, tool("call-4", f"Edit {SESSION_PATH}", "edit", "completed", input={"path": SESSION_PATH},
                                                     diffs=[{"path": SESSION_PATH, "old_text": OLD_MARK, "new_text": NEW_MARK}],
                                                     locations=[{"path": SESSION_PATH, "line": 12}])))},
    {"wait": 500, "event": ev(item("m-b5", U2, tool("call-5", f"Write {TEST_PATH}", "edit", "completed", input={"path": TEST_PATH},
                                                     diffs=[{"path": TEST_PATH, "new_text": NEW_TEST}], locations=[{"path": TEST_PATH}])))},
    {"wait": 200, "event": ev(item("m-b2", U2, plan(["completed", "completed", "in_progress"]), done=False))},
    {"wait": 300, "stream": {"message": item("m-b6", U2, tool("call-6", PYTEST_INPUT["command"], "execute", "failed", input=PYTEST_INPUT, output=FAIL_OUTPUT)), "cps": 900}},
    {"wait": 300, "stream": {"message": item("m-b7", U2, {"type": "text", "text": "测试库里还没有表：本地 postgres 没有启动。我需要先把它拉起来。"}), "cps": 60}},
    {"wait": 300, "event": ev(item("m-b8", U2, tool("call-8", DOCKER_INPUT["command"], "execute", "pending", input=DOCKER_INPUT), done=False))},
    {"wait": 0, "event": {"type": "control", "control": control("running", pending=[REQUEST])}},
    {"wait": 0, "until": "answer", "request_id": "req-1"},
    {"wait": 100, "event": ev(item("m-b8", U2, tool("call-8", DOCKER_INPUT["command"], "execute", "in_progress", input=DOCKER_INPUT, output=""), done=False))},
    {"wait": 200, "stream": {"message": item("m-b8", U2, tool("call-8", DOCKER_INPUT["command"], "execute", "completed", input=DOCKER_INPUT, output=DOCKER_OUTPUT)), "cps": 40}},
    {"wait": 300, "stream": {"message": item("m-b9", U2, tool("call-9", PYTEST_INPUT["command"], "execute", "completed", input=PYTEST_INPUT, output=PASS_OUTPUT)), "cps": 900}},
    {"wait": 200, "event": ev(item("m-b2", U2, plan(["completed", "completed", "completed"]), done=False))},
    {"wait": 300, "stream": {"message": item("m-b10", U2, {"type": "text", "text": FINAL}), "cps": 90}},
    {"wait": 0, "event": ev(item("m-b2", U2, plan(["completed", "completed", "completed"])))},
    {"wait": 0, "event": {"type": "control", "control": control("idle", used=88_900)}},
]

# ── reply (demo composer) ───────────────────────────────────────────────────────────────────────────────────────

REPLY = "收到。这是演示环境：消息由本机的回放脚本应答，不会发到真实的 Agent。\n\n在 v3 里，这段文字和上面的工具调用由同一个渲染包绘制，Web、Desktop、iOS 和 Android 看到的完全一致。"
reply = [
    {"wait": 0, "event": {"type": "control", "control": control("running", used=89_400)}},
    {"wait": 400, "stream": {"message": item("m-$X-1", "$TURN", {"type": "thinking", "text": "这是一条演示回复，不需要调用工具。"}), "cps": 60}},
    {"wait": 150, "stream": {"message": item("m-$X-2", "$TURN", {"type": "text", "text": REPLY}), "cps": 80}},
    {"wait": 0, "event": {"type": "control", "control": control("idle", used=90_100)}},
]


def write(name: str, value: object) -> None:
    (HERE / name).write_text(json.dumps(value, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


write("workspace.json", workspace)
write("session-demo.json", {"account": ACCOUNT, "snapshot": snapshot, "script": copy.deepcopy(script), "reply": reply})
print(f"wrote workspace.json, session-demo.json ({len(script)} script steps, {len(history)} history items)")
