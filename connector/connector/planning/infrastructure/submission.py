from connector.runtime_protocol import RuntimeAttachment
from connector.runtime_protocol.planning import NativePlanningResult


async def submit(
    runtime, session_id: str, external_id: str | None, request: dict
) -> NativePlanningResult:
    attachments = tuple(
        RuntimeAttachment(
            file_id=item["fileId"],
            name=item.get("name"),
            media_type=item.get("mediaType"),
            size=item.get("size"),
        )
        for item in request.get("attachments", [])
    )
    result = await runtime.start_turn(
        session_id,
        external_id,
        request["content"],
        attachments=attachments,
        client_message_id=request["operationId"],
    )
    return NativePlanningResult(
        outcome="applied" if result.ok else "rejected",
        code=result.code,
        message=result.message,
        execution=("started" if result.result.get("turnId") else "accepted")
        if result.ok
        else "rejected",
        data=dict(result.result),
    )
