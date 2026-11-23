#!/usr/bin/env python3
"""Zero-dependency validator for contracts/aa-v3/1.0."""

from __future__ import annotations

import base64
import hashlib
import json
import re
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


PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def normalize_pairing_code(value: str) -> str | None:
    code = re.sub(r"[\s-]", "", value.upper()).replace("O", "0").replace("I", "1").replace("L", "1")
    if len(code) == 10 and all(c in PAIRING_CODE_ALPHABET for c in code):
        return code
    return None


def check_pairing_codes(fixture: dict[str, Any]) -> int:
    kdf = fixture["kdf"]
    for case in fixture["valid"]:
        code = normalize_pairing_code(case["input"])
        if code != case["code"]:
            raise AssertionError(f"pairing code {case['input']!r} normalizes to {code!r}, want {case['code']!r}")
        key = hashlib.pbkdf2_hmac(
            "sha256", code.encode(), (kdf["salt_prefix"] + case["instance_id"]).encode(), kdf["iterations"], kdf["length"]
        )
        psk = base64.urlsafe_b64encode(key).rstrip(b"=").decode()
        if psk != case["psk"]:
            raise AssertionError(f"pairing code {case['input']!r}: psk {psk}, want {case['psk']}")
    for value in fixture["invalid"]:
        if normalize_pairing_code(value) is not None:
            raise AssertionError(f"{value!r} must not be accepted as a pairing code")
    for case in fixture["fingerprints"]:
        raw = base64.urlsafe_b64decode(case["public_key"] + "=" * (-len(case["public_key"]) % 4))
        hexed = hashlib.sha256(raw).digest()[:16].hex().upper()
        got = " ".join(hexed[i : i + 4] for i in range(0, 32, 4))
        if got != case["fingerprint"]:
            raise AssertionError(f"fingerprint {got}, want {case['fingerprint']}")
    return len(fixture["valid"]) + len(fixture["invalid"]) + len(fixture["fingerprints"])


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

    pairing_vectors = check_pairing_codes(
        json.loads((ROOT / "fixtures/pairing-code.json").read_text(encoding="utf-8"))
    )

    print(
        f"contracts/aa-v3/1.0 OK: {len(manifest['schemas'])} schemas, "
        f"{len(fixtures['cases'])} merge fixture cases, {pairing_vectors} pairing code vectors verified."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
