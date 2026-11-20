#!/usr/bin/env python3
"""Zero-dependency validator for contracts/aa-v3/1.0."""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent


def parse_instant(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def run_merge_case(case: dict[str, Any]) -> None:
    local_e2ee = set(case["local_e2ee_devices"])
    sessions_by_device: dict[str, list[dict[str, Any]]] = {}
    device_states: dict[str, dict[str, Any]] = {}

    for device_id, cached in case["initial_cache"].items():
        sessions_by_device[device_id] = list(cached.get("sessions", []))
        device_states[device_id] = {"status": "cached", "stale": True}

    for event in case["events"]:
        source = event["source"]
        result = event["result"]
        device_id = result["device_id"]
        status = result["status"]

        if source == "control_plane" and device_id in local_e2ee:
            if status == "encrypted":
                # Marker only: never overwrite local tunnel state or cache.
                device_states.setdefault(
                    device_id, {"status": "encrypted", "stale": True}
                )
                continue
            # Anti-downgrade: refuse plaintext results for locally pinned E2EE devices.
            device_states[device_id] = {
                "status": "error",
                "stale": True,
                "error_code": "e2e_required_locally",
            }
            continue

        if status == "ok":
            sessions_by_device[device_id] = list(result["value"]["sessions"])
            device_states[device_id] = {"status": "ok", "stale": False}
        elif status == "encrypted":
            device_states.setdefault(device_id, {"status": "encrypted", "stale": True})
        else:
            state: dict[str, Any] = {"status": status, "stale": True}
            if "error" in result and "code" in result["error"]:
                state["error_code"] = result["error"]["code"]
            device_states[device_id] = state

    merged = [s for items in sessions_by_device.values() for s in items]
    merged.sort(
        key=lambda s: (
            0 if s["pinned"] else 1,
            -parse_instant(s["updated_at"]),
            s["device_id"],
            s["id"],
        )
    )
    got_order = [s["id"] for s in merged]
    want_order = case["expected"]["session_order"]
    if got_order != want_order:
        raise AssertionError(
            f"{case['name']}: session_order={got_order!r}, want {want_order!r}"
        )

    want_states = case["expected"]["device_states"]
    if device_states != want_states:
        raise AssertionError(
            f"{case['name']}: device_states={device_states!r}, want {want_states!r}"
        )


def main() -> int:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    for rel in [*manifest["schemas"], *manifest["fixtures"]]:
        path = ROOT / rel
        if not path.is_file():
            raise FileNotFoundError(f"Missing contract file: {path}")
        json.loads(path.read_text(encoding="utf-8"))

    fixtures = json.loads(
        (ROOT / "fixtures/session-merge.json").read_text(encoding="utf-8")
    )
    for case in fixtures["cases"]:
        run_merge_case(case)

    print(
        f"contracts/aa-v3/1.0 OK: {len(manifest['schemas'])} schemas, "
        f"{len(fixtures['cases'])} merge fixture cases verified."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
