from __future__ import annotations

import json
from pathlib import Path

from connector.claude.preferences import read_local_preferences


def test_reads_known_fields_from_settings_json(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps(
            {
                "permissions": {"defaultMode": "bypassPermissions"},
                "model": "claude-opus-4-7",
                "effort": "xhigh",
                "ignoredExtra": True,
            }
        )
    )
    prefs = read_local_preferences(path)
    assert prefs["permissionMode"] == "bypassPermissions"
    assert prefs["model"] == "claude-opus-4-7"
    assert prefs["effort"] == "xhigh"
    assert prefs["readAt"].endswith("Z")
    assert "ignoredExtra" not in prefs


def test_missing_file_returns_empty(tmp_path: Path) -> None:
    assert read_local_preferences(tmp_path / "no-such.json") == {}


def test_partial_fields_surface_as_none(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"model": "claude-sonnet-4-6"}))
    prefs = read_local_preferences(path)
    assert prefs["permissionMode"] is None
    assert prefs["model"] == "claude-sonnet-4-6"
    assert prefs["effort"] is None


def test_malformed_json_returns_empty(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    path.write_text("{ not json")
    assert read_local_preferences(path) == {}


def test_non_dict_root_returns_empty(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(["not", "a", "dict"]))
    assert read_local_preferences(path) == {}


def test_non_string_field_values_become_none(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    path.write_text(
        json.dumps(
            {
                "permissions": {"defaultMode": 42},
                "model": ["not-a-string"],
                "effort": None,
            }
        )
    )
    prefs = read_local_preferences(path)
    assert prefs["permissionMode"] is None
    assert prefs["model"] is None
    assert prefs["effort"] is None
