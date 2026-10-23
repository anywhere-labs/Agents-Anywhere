"""Private JSON-lines worker; its environment belongs to one Runtime instance."""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, is_dataclass
from typing import Any


def _json_value(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        return asdict(value)
    raise TypeError("Unsupported Claude history value")


def main() -> None:
    import claude_agent_sdk

    methods = {
        name: getattr(claude_agent_sdk, name)
        for name in ("list_sessions", "get_session_info", "get_session_messages")
    }
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = methods[request["method"]](**request["kwargs"])
            response = json.dumps({"ok": True, "result": result}, default=_json_value)
        except Exception:  # noqa: BLE001 - isolate SDK failures at the worker boundary
            # Neither transcript content nor SDK exception details go to logs.
            response = json.dumps({"ok": False})
        sys.stdout.write(response + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
