from ..domain.definitions import AcpError, fingerprint
from ..domain.operations import require_same_input

OPERATIONS = {
    "authentication.status": ("session.authentication.read", False),
    "resources.get": ("session.resources.read", False),
    "resources.reload": ("session.resources.update", True),
    "queue.get": ("session.queue.read", False),
    "queue.clear": ("session.queue.update", True),
    "message.follow_up": ("session.follow_up", True),
    "session.rename": ("session.rename", True),
    "session.fork": ("session.fork", True),
    "directories.add": ("session.directories.update", True),
    "tools.set": ("session.tools.update", True),
}


async def execute_agent_operation(app, values):
    from .agent_capabilities import AgentCapabilities
    operation = values.get("operation")
    if operation not in OPERATIONS:
        raise AcpError("unsupported_operation", "Agent 操作未登记。")
    binding = app.store.require("binding", values["sessionId"])
    if values.get("expectedGeneration") != binding["owner_generation"]:
        raise AcpError("owner_changed", "执行者已变化。")
    key = fingerprint([values["sessionId"], values["operationId"]])
    digest = fingerprint(values)
    previous = app.store.get("agent_operation", key)
    if previous:
        require_same_input(previous["inputDigest"], digest)
        return previous["result"]
    capability, writable = OPERATIONS[operation]
    service = AgentCapabilities(app)
    service.context(values["sessionId"])
    if not service.supported(values["sessionId"], capability):
        raise AcpError("agent_capability_unsupported", "Agent 未提供此能力。")
    row = {"inputDigest": digest, "result": {"operationId": values["operationId"], "phase": "outcome_unknown"}}
    with app.store.transaction():
        app.store.put("agent_operation", key, row)
    result = await service.invoke(values["sessionId"], capability, "aa/operate", values, writable=writable)
    row["result"] = result
    with app.store.transaction():
        app.store.put("agent_operation", key, row)
    return result
