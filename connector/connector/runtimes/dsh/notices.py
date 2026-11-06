"""Failed-turn reporting for the DSH runtime.

The plugin reports ``session.turnEnded`` with an ``outcome`` but, before 2.2,
it dropped the model-side failure that caused it (a 402 from the gateway, a
401 from an expired key, a transport error). A failed turn then looked exactly
like a turn that produced no answer: the session went idle and the user saw
nothing.

The Connector turns that into two artefacts the user can actually see:

* an ``execution_error`` interaction notice, mirroring what the Codex runtime
  already publishes for ``turn/failed``;
* a settled assistant message on the timeline, so the reason survives a page
  reload instead of living only in the plugin's session log.
"""

from __future__ import annotations

import hashlib
from typing import Any, Mapping

from connector.runtime_protocol.models import RuntimeTimelineItem, SessionNotice
from connector.runtime_protocol.timeline import timeline_content_hash

# Gateway failures arrive as one-line JSON blobs. Users need the cause, not
# the transport shape, so the common ones get a sentence they can act on.
_KNOWN_FAILURES = (
    (
        "insufficient_user_quota",
        "模型网关额度不足（ko-api 402）。补充额度后重新发送即可，本轮没有产生回复。",
    ),
    (
        "invalid_api_key",
        "模型网关鉴权失败（API Key 无效或已过期）。检查 ko-api 令牌后重新发送。",
    ),
    (
        "model_not_found",
        "模型不存在或当前渠道未启用该模型。检查 dsh 的 provider 配置与 ko-api 渠道。",
    ),
)


def _failure_fields(failure: Mapping[str, Any]) -> tuple[str, str]:
    code = str(failure.get("code") or "dsh_turn_failed")
    message = str(failure.get("message") or "").strip()
    if not message:
        message = "模型没有返回结果，本轮已中断。"
    return code, message


def readable_failure(failure: Mapping[str, Any]) -> str:
    """Turn a raw provider error into one actionable sentence (or keep it)."""

    code, message = _failure_fields(failure)
    haystack = f"{code} {message}".lower()
    for needle, explanation in _KNOWN_FAILURES:
        if needle in haystack:
            return f"{explanation}\n\n原始错误：{message}"
    return message


def turn_failure_notice(
    *,
    session_id: str,
    external_session_id: str | None,
    failure: Mapping[str, Any],
    turn_id: str | None,
) -> SessionNotice:
    code, message = _failure_fields(failure)
    component = turn_id or code
    return SessionNotice(
        notice_id=f"notice_error_{session_id}_{component}",
        session_id=session_id,
        runtime="dsh",
        type="interaction",
        title="模型调用失败",
        message=readable_failure(failure),
        severity="error",
        status="open",
        interaction_type="execution_error",
        blocking={"scope": "session", "targetId": session_id},
        response_required=False,
        actions=(),
        source={
            "sessionId": external_session_id,
            **({"turnId": turn_id} if turn_id else {}),
        },
        context={
            "kind": "execution_error",
            "error": {"code": code, "message": message},
            **({"turnId": turn_id} if turn_id else {}),
        },
        metadata={"source": "dsh.turn/end"},
    )


def turn_failure_item(
    *,
    session_id: str,
    external_session_id: str | None,
    failure: Mapping[str, Any],
    turn_id: str | None,
) -> RuntimeTimelineItem:
    code, _ = _failure_fields(failure)
    text = f"⚠️ 本轮执行失败\n\n{readable_failure(failure)}"
    content: dict[str, Any] = {"format": "markdown", "kind": "markdown", "text": text}
    digest = hashlib.sha256(
        f"{session_id}:{turn_id or code}:{text}".encode()
    ).hexdigest()[:48]
    item_id = f"dsh_error_{digest}"
    seq = failure.get("seq")
    order_seq = seq if isinstance(seq, int) and not isinstance(seq, bool) else 0
    return RuntimeTimelineItem(
        id=item_id,
        session_id=session_id,
        type="message",
        status="done",
        role="assistant",
        order_seq=order_seq,
        content_hash=timeline_content_hash("message", "done", "assistant", content),
        content=content,
        source={
            "runtime": "dsh",
            "sessionId": external_session_id,
            "itemId": item_id,
            "itemType": "aa/turn-failure",
        },
        metadata={"kind": "execution_error", "code": code},
    )
