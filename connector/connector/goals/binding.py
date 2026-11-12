from connector.goals.service import GoalService
from connector.goals.store import GoalStore


def bind_goals(runtime, host, port):
    kv = getattr(host, "runtime_kv", None)
    publish = getattr(host, "publish_goal", None)
    if kv is None or not callable(publish):
        return runtime
    runtime.__dict__["_goals"] = GoalService(
        runtime.identity.runtime,
        port,
        GoalStore(kv.path.parent / "goal.sqlite3"),
        publish,
    )
    host.__dict__["_goal_port"] = port
    host.__dict__["_goal_service"] = runtime.goals
    return runtime
