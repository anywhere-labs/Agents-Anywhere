"""Export golden identity vectors from the real v2 Connector functions.

Every output in ``contracts/identity-vectors/1.0/vectors.json`` is produced by
calling the v2 implementation itself (Python in ``connector/``; the DSH plugin
algorithms by running ``dsh-bridge-next/src/host/dsh-runtime/identity.ts`` under
Node). The script never re-implements an algorithm: where v2 inlines a rule in a
larger method, the method is driven with minimal fakes, and the few places that
compose public helpers are marked ``composed`` in the category metadata.

Usage::

    cd connector && uv run python scripts/export_identity_vectors.py [--check]

``--check`` regenerates in memory and fails when the committed file differs.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import math
import platform as host_platform
import subprocess
import sys
import unicodedata
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
OUTPUT = REPO / "contracts" / "identity-vectors" / "1.0" / "vectors.json"
DSH_PLUGIN_IDENTITY = REPO / "dsh-bridge-next" / "src" / "host" / "dsh-runtime" / "identity.ts"

sys.path.insert(0, str(REPO / "connector"))

from connector.planning.domain import session as planning_session
from connector.runtime_protocol import filesystem
from connector.runtime_protocol.instance_binding import (
    RuntimeInstanceHost,
    _source_key_digest,
)
from connector.runtime_protocol.instance_models import (
    RuntimeInstanceSpec,
    RuntimeSourceKey,
)
from connector.runtimes import custom_models
from connector.runtimes.acp import composition as acp_composition
from connector.runtimes.acp.domain import catalogs as acp_catalogs
from connector.runtimes.acp.domain.definitions import fingerprint
from connector.runtimes.acp.infrastructure.projection import Projection
from connector.runtimes.acp.profiles.pi import history as pi_history
from connector.runtimes.acp.runtime import AcpRuntime
from connector.runtimes.claude.domain import models as claude_models
from connector.runtimes.claude.domain import permissions as claude_permissions
from connector.runtimes.claude.domain.session import ClaudeSession
from connector.runtimes.claude.domain.session import (
    stable_session_id as claude_stable_session_id,
)
from connector.runtimes.claude.sessions import reader as claude_reader
from connector.runtimes.claude.timeline import messages as claude_messages
from connector.runtimes.codex.domain import catalogs as codex_catalogs
from connector.runtimes.codex.domain import input_requests as codex_input_requests
from connector.runtimes.codex.domain import sessions as codex_sessions
from connector.runtimes.codex.provider import CodexProvider
from connector.runtimes.codex.timeline import identity as codex_identity
from connector.runtimes.dsh import identity as dsh_identity
from connector.runtimes.dsh.provider import DshProvider
from connector.runtimes.session_identity import stable_runtime_session_id
from connector.server.protocol import protocol_selection_id

# ---------------------------------------------------------------------------
# Shared edge inputs
# ---------------------------------------------------------------------------

LONG_ASCII = "".join(chr(ord("a") + i % 26) for i in range(2048))
LONG_CJK = "会话" * 400
LONG_EMOJI = "😀🎉" * 300
EDGE_STRINGS: list[str] = [
    "",
    "a",
    "019a8f5e-6a1d-7c2b-9e3f-0123456789ab",
    "中文会话标识",
    "emoji😀🎉🧑‍💻",
    "e\u0301-combining",
    "\u00e9-precomposed",
    "nul\u0000inside",
    "\u0000",
    "a:b:c",
    "::",
    "a/b\\c",
    "/Users/someone/.dsh/agents-anywhere",
    "C:\\Users\\someone\\.codex",
    "with space and\ttab\nnewline",
    "\"quote'and`backtick",
    "\uffff\U00010000\U0010ffff",
    "ß-İ-ı-Σ-ς",
    "rti_abc-DEF_123",
    LONG_ASCII,
    LONG_CJK,
    LONG_EMOJI,
]
NON_EMPTY = [value for value in EDGE_STRINGS if value]


def _js_faithful(value: Any) -> None:
    """Reject inputs whose JSON transport is lossy in JavaScript.

    TypeScript reads the vectors through ``JSON.parse``. Python ints beyond 2^53
    and integral floats (``1.0``) have no distinct JavaScript representation, so
    vectors must not depend on them; the README documents this limitation.
    """

    if isinstance(value, bool) or value is None or isinstance(value, str):
        return
    if isinstance(value, int):
        if abs(value) > 2**53 - 1:
            raise AssertionError(f"int beyond JS safe range: {value}")
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise AssertionError("non-finite float")
        if value.is_integer() and abs(value) < 1e21:
            raise AssertionError(f"integral float is ambiguous in JS: {value!r}")
        return
    if isinstance(value, list):
        for item in value:
            _js_faithful(item)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            assert isinstance(key, str)
            _js_faithful(item)
        return
    raise AssertionError(f"unsupported vector value: {type(value)!r}")


def _wire(value: Any) -> Any:
    """Simulate JSON transport: what both Python and TS see after json.loads."""

    _js_faithful(value)
    return json.loads(json.dumps(value))


def _call(function, *args, **kwargs) -> dict[str, Any]:
    try:
        return {"output": function(*args, **kwargs)}
    except Exception as error:  # noqa: BLE001 -- the error class is the vector
        return {"error": type(error).__name__}


def _vector(inputs: dict[str, Any], result: dict[str, Any], name: str | None = None) -> dict[str, Any]:
    _js_faithful(inputs)
    entry: dict[str, Any] = {}
    if name:
        entry["name"] = name
    entry["input"] = inputs
    entry.update(result)
    return entry


def _category(source: str, description: str, vectors: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    if len(vectors) < 20:
        raise AssertionError(f"{source}: only {len(vectors)} vectors")
    return {"source": source, "description": description, **extra, "vectors": vectors}


# ---------------------------------------------------------------------------
# Session identity
# ---------------------------------------------------------------------------


def session_categories() -> dict[str, Any]:
    result: dict[str, Any] = {}

    vectors = []
    triples = [
        ("conn_1", "codex", "thread-1"),
        ("conn_1", "claude", "019a8f5e-6a1d-7c2b-9e3f-0123456789ab"),
        ("conn_1", "dsh", "ext"),
        ("conn_1", "pi", "ext"),
        ("", "codex", "x"),
        ("conn", "", "x"),
        ("conn", "codex", ""),
        ("a:b", "c", "d"),
        ("a", "b:c", "d"),
        ("a", "b", "c:d"),
    ]
    triples += [("conn_1", "codex", value) for value in NON_EMPTY]
    triples += [(value, "claude", "ext-1") for value in NON_EMPTY[:8]]
    triples += [("conn_1", runtime, "ext-1") for runtime in ("opencode", "hermes", "antigravity", "codebuddy", "commandcode", "mimo", "minimax", "rti_x")]
    for connector_id, runtime, external in triples:
        vectors.append(_vector(
            {"connectorId": connector_id, "runtime": runtime, "externalSessionId": external},
            _call(stable_runtime_session_id, connector_id, runtime, external),
        ))
    result["session.stableRuntimeSessionId"] = _category(
        "connector/connector/runtimes/session_identity.py:stable_runtime_session_id",
        "sess_{runtime}_{sha256(utf8(connectorId:runtime:externalSessionId)).hex[:24]}; any empty component raises ValueError.",
        vectors,
    )

    for name, function, runtime in (
        ("session.codexStableSessionId", codex_sessions.stable_session_id, "codex"),
        ("session.claudeStableSessionId", claude_stable_session_id, "claude"),
    ):
        vectors = []
        namespaces = ["conn_1", "conn_1:codex:rti_abc", "conn_1:claude:rti_abc:" + "0" * 24, "", *NON_EMPTY[:6]]
        externals = ["thread-1", "", *NON_EMPTY]
        for namespace in namespaces:
            for external in externals[:4]:
                vectors.append(_vector({"namespace": namespace, "externalSessionId": external}, _call(function, namespace, external)))
        for external in externals[4:]:
            vectors.append(_vector({"namespace": "conn_1", "externalSessionId": external}, _call(function, "conn_1", external)))
        source = (
            "connector/connector/runtimes/codex/domain/sessions.py:stable_session_id"
            if runtime == "codex"
            else "connector/connector/runtimes/claude/domain/session.py:stable_session_id"
        )
        result[name] = _category(
            source,
            f"stable_runtime_session_id(namespace, '{runtime}', externalSessionId). The namespace is Host.session_namespace (see session.namespace).",
            vectors,
        )

    vectors = []
    for kind, key in [
        ("codex_home", "/users/someone/.codex"),
        ("dsh_bridge_endpoint", "/users/someone/.dsh/agents-anywhere/bridge/endpoint.json"),
        ("k", "v"),
        ("kind:with:colon", "key"),
        ("kind", "key\u0000embedded"),
        ("", ""),
        ("", "x"),
        ("x", ""),
        ("中文", "路径/会话"),
        ("emoji😀", "🎉"),
        *[("codex_home", value) for value in NON_EMPTY],
    ]:
        vectors.append(_vector({"kind": kind, "key": key}, _call(_source_key_digest, SimpleNamespace(kind=kind, key=key))))
    result["session.sourceKeyDigest"] = _category(
        "connector/connector/runtime_protocol/instance_binding.py:_source_key_digest",
        "sha256(utf8(kind + '\\0' + key)).hex[:24]. The digest itself does not validate; RuntimeSourceKey rejects blank or control-character fields (session.namespace).",
        vectors,
    )

    vectors = []
    cases: list[tuple[str, str, str, tuple[str, str] | None]] = [
        ("conn_1", "codex", "codex", None),
        ("conn_1", "codex", "codex", ("codex_home", "/users/a/.codex")),
        ("conn_1", "dsh", "dsh", ("dsh_bridge_endpoint", "/users/a/.dsh/agents-anywhere/bridge/endpoint.json")),
        ("conn_1", "codex", "rti_abc", None),
        ("conn_1", "codex", "rti_abc", ("codex_home", "/users/a/.codex")),
        ("conn_1", "claude", "rti_abc", None),
        ("conn_1", "dsh", "rti_X-y_9", ("dsh_bridge_endpoint", "/users/a/.dsh/agents-anywhere/bridge/endpoint.json")),
        ("conn_1", "pi", "rti_pi", None),
        ("conn_1", "hermes", "rti_h", None),
        ("conn_1", "opencode", "rti_o", None),
        ("conn_1", "antigravity", "rti_a", None),
        ("conn_1", "codebuddy", "rti_c", None),
        ("conn_1", "commandcode", "rti_cc", None),
        ("conn_1", "mimo", "rti_m", None),
        ("conn_1", "minimax", "rti_mm", None),
        ("连接器😀", "codex", "rti_abc", ("codex_home", "/用户/a/.codex")),
        ("conn:with:colons", "codex", "rti_abc", ("kind:x", "key:y")),
        ("", "codex", "rti_abc", None),
        ("", "codex", "codex", None),
        (LONG_ASCII, "codex", "rti_" + "z" * 124, ("codex_home", LONG_CJK)),
        ("conn_1", "codex", "rti_abc", ("codex_home", "bad\u0000key")),
        ("conn_1", "codex", "rti_abc", ("codex_home", "   ")),
        ("conn_1", "codex", "rti_abc", ("codex_home", "tab\tkey")),
    ]
    for connector_id, runtime_type, runtime_id, source in cases:

        def namespace(connector_id=connector_id, runtime_type=runtime_type, runtime_id=runtime_id, source=source):
            source_key = RuntimeSourceKey(kind=source[0], key=source[1]) if source else None
            host = RuntimeInstanceHost(
                base=SimpleNamespace(connector_id=connector_id),
                instance=RuntimeInstanceSpec(runtime_id=runtime_id, runtime_type=runtime_type, name="Instance"),
                source_key=source_key,
            )
            return host.session_namespace

        vectors.append(_vector(
            {
                "connectorId": connector_id,
                "runtimeType": runtime_type,
                "runtimeId": runtime_id,
                "sourceKey": {"kind": source[0], "key": source[1]} if source else None,
            },
            _call(namespace),
        ))
    result["session.namespace"] = _category(
        "connector/connector/runtime_protocol/instance_binding.py:RuntimeInstanceHost.session_namespace",
        "Legacy instance (runtimeId == runtimeType): connectorId, the source key is ignored. Named instance: "
        "connectorId:runtimeType:runtimeId[:sourceKeyDigest]. A source key with a blank or control-character field raises ValueError "
        "(RuntimeSourceKey); runtimeId/runtimeType inputs here are always valid.",
        vectors,
    )

    # Filesystem resource keys (pure part: input is already canonical_path()).
    raw_paths = [
        "/nonexistent-aa-vectors/plain/path",
        "/nonexistent-aa-vectors/MiXeD/Case.JSON",
        "/nonexistent-aa-vectors/Straße/STRASSE",
        "/nonexistent-aa-vectors/ẞig/ß",
        "/nonexistent-aa-vectors/İstanbul/ıi",
        "/nonexistent-aa-vectors/ΣΑΣ/ς",
        "/nonexistent-aa-vectors/e\u0301/\u00e9",
        "/nonexistent-aa-vectors/Å/\u212b",
        "/nonexistent-aa-vectors/ﬁle/ﬀ",
        "/nonexistent-aa-vectors/ᏣᎳᎩ/ꮳꮃꭹ",
        "/nonexistent-aa-vectors/中文/会话",
        "/nonexistent-aa-vectors/😀/🎉",
        "/nonexistent-aa-vectors/with space/and:colon",
        "/nonexistent-aa-vectors/ＡＢＣ/ｆｕｌｌ",
        "/nonexistent-aa-vectors/ǅ/ǈ/ǋ",
        "/nonexistent-aa-vectors/Ω/\u2126/K/\u212a",
        "/nonexistent-aa-vectors/ΐ/ΰ",
        "/nonexistent-aa-vectors/" + "Ab" * 300,
        "/nonexistent-aa-vectors/Ⅻ/ⓐⒶ",
        "/nonexistent-aa-vectors/Ꞵ/𐐀𐐨",
    ]
    vectors = []
    for raw in raw_paths:
        canonical = filesystem.canonical_path(raw)
        for platform_name in ("darwin", "linux"):
            with mock.patch.object(filesystem.sys, "platform", platform_name):
                result_value = _call(filesystem.filesystem_resource_key, canonical)
            vectors.append(_vector({"canonicalPath": canonical, "platform": platform_name}, result_value))
    result["session.filesystemResourceKey"] = _category(
        "connector/connector/runtime_protocol/filesystem.py:filesystem_resource_key",
        "Input is canonical_path() output (absolute, symlinks resolved, normcase applied). darwin: NFC(str.casefold(path)); "
        "linux: unchanged. Windows (ntpath.normcase via LCMapStringEx) is not covered.",
        vectors,
    )

    vectors = []
    homes = [
        "/nonexistent-aa-vectors/home/.dsh",
        "/nonexistent-aa-vectors/Home/.DSH",
        "/nonexistent-aa-vectors/用户/.dsh",
        "/nonexistent-aa-vectors/Straße/.dsh",
        "/nonexistent-aa-vectors/😀",
        "/nonexistent-aa-vectors/with space",
        "/nonexistent-aa-vectors/e\u0301",
        "/nonexistent-aa-vectors/ꮳ",
        "/nonexistent-aa-vectors/a:b",
        "/nonexistent-aa-vectors/" + "X" * 500,
        "/",
    ]
    dsh_provider = object.__new__(DshProvider)
    codex_provider = object.__new__(CodexProvider)
    for home in homes:
        canonical = filesystem.canonical_path(home)
        for platform_name in ("darwin", "linux"):
            with mock.patch.object(filesystem.sys, "platform", platform_name):
                key = dsh_provider.session_source_key(SimpleNamespace(values={"dshHome": canonical}))
            vectors.append(_vector(
                {"runtime": "dsh", "home": canonical, "platform": platform_name},
                {"output": {"kind": key.kind, "key": key.key}},
            ))
            with mock.patch.object(filesystem.sys, "platform", platform_name):
                key = codex_provider.session_source_key(SimpleNamespace(values={"codexHome": canonical}))
            vectors.append(_vector(
                {"runtime": "codex", "home": canonical, "platform": platform_name},
                {"output": {"kind": key.kind, "key": key.key}},
            ))
    result["session.sourceKey"] = _category(
        "connector/connector/runtimes/dsh/provider.py:DshProvider.session_source_key, connector/connector/runtimes/codex/provider.py:CodexProvider.session_source_key",
        "dsh: {kind: dsh_bridge_endpoint, key: filesystem_resource_key(<dshHome>/agents-anywhere/bridge/endpoint.json)} (the 1.x endpoint path, kept as identity); "
        "codex: {kind: codex_home, key: filesystem_resource_key(<codexHome>)}. Input home is already canonical.",
        vectors,
    )

    # ACP native inventory (drives the real AcpRuntime.list_sessions).
    vectors = []
    natives = ["native-1", "019a8f5e-6a1d-7c2b-9e3f-0123456789ab", "中文", "😀", "a:b", "nul\u0000", LONG_ASCII, "x" * 3, "/path/like", "ses_\\back"]
    for runtime_id in ("hermes", "rti_abc", "opencode", "rti_😀"):
        for native in natives[: 10 if runtime_id == "hermes" else 4]:
            vectors.append(_vector({"runtimeId": runtime_id, "nativeSessionId": native}, {"output": _acp_native_session_id(runtime_id, native)}))
    result["session.acpNativeInventoryId"] = _category(
        "connector/connector/runtimes/acp/runtime.py:AcpRuntime.list_sessions",
        "Unbound ACP sessions from session/list: 'acp_native_' + fingerprint([runtimeId, nativeSessionId])[:40], "
        "fingerprint = sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))).hex. "
        "Sessions created through AA use the platform session id reserved by the Server (no derivation).",
        vectors,
    )

    vectors = []
    for runtime_id in ("pi", "rti_pi"):
        for path in ("/users/a/.pi/agent/sessions/x.jsonl", "/用户/会话.jsonl", "C:\\Users\\a\\x.jsonl", "/a:b/😀.jsonl", "/" + "p" * 300):
            for entry_id in ("019a8f5e", "", "中文", "a\u0000b", LONG_ASCII[:200]):
                if len(vectors) >= 30:
                    break
                vectors.append(_vector(
                    {"runtimeId": runtime_id, "path": path, "nativeSessionId": entry_id},
                    {"output": "pi_native_" + fingerprint([runtime_id, path, entry_id])[:40]},
                ))
    result["session.piNativeSessionId"] = _category(
        "connector/connector/runtimes/acp/profiles/pi/native_runtime.py:PiNativeRuntime.scan",
        "Unbound Pi native history: 'pi_native_' + fingerprint([runtimeId, str(path), headerId])[:40]. "
        "composed: the rule is inline in scan(); outputs use the real fingerprint().",
        vectors,
        composed=True,
    )

    vectors = []
    for namespace in ("conn_1", "conn_1:pi:rti_pi", "连接器", "a:b", "", LONG_ASCII):
        for runtime_id in ("pi", "rti_pi", "hermes", "rti_😀"):
            vectors.append(_vector({"sessionNamespace": namespace, "runtimeId": runtime_id}, {"output": _acp_runtime_root(namespace, runtime_id)}))
    result["storage.acpRuntimeRoot"] = _category(
        "connector/connector/runtimes/acp/composition.py:runtime_root",
        "Directory name of one ACP instance's private state: sha256(utf8(sessionNamespace + ':' + runtimeId)).hex (full 64 chars).",
        vectors,
    )
    return result


def _acp_native_session_id(runtime_id: str, native_id: str) -> str:
    class FakeStore:
        def values(self, kind):
            return []

        def transaction(self):
            return contextlib.nullcontext()

        def put(self, kind, key, value):
            pass

    class FakeClient:
        def __init__(self):
            self.capabilities = {"sessionCapabilities": {"list": {}}}

        async def list_sessions(self, cursor=None):
            return {"sessions": [{"sessionId": native_id}]}

    async def inventory_client():
        return FakeClient()

    runtime = object.__new__(AcpRuntime)
    runtime.config = SimpleNamespace(runtime="hermes", runtime_id=runtime_id)
    runtime.profile = SimpleNamespace(native_inventory=True)
    runtime.app = SimpleNamespace(store=FakeStore(), inventory_client=inventory_client)
    rows = asyncio.run(runtime.list_sessions())
    assert len(rows) == 1
    return rows[0].session_id


def _acp_runtime_root(namespace: str, runtime_id: str) -> str:
    host = SimpleNamespace(session_namespace=namespace, runtime_kv=SimpleNamespace(path=Path("/state/kv.json")))
    return acp_composition.runtime_root(SimpleNamespace(runtime_id=runtime_id), host).name


# ---------------------------------------------------------------------------
# Selection identity
# ---------------------------------------------------------------------------


def selection_categories() -> dict[str, Any]:
    result: dict[str, Any] = {}
    identities: list[Any] = [
        {},
        {"model_id": "gpt-5", "reasoning_id": None},
        {"model_id": "gpt-5", "reasoning_id": "high"},
        {"reasoning_id": "high", "model_id": "gpt-5"},
        {"permission_id": "default"},
        {"b": 1, "a": 2, "A": 3, "_": 4, "aa": 5, "a\u0000": 6},
        {"é": 1, "e": 2, "z": 3, "中": 4, "😀": 5, "\uffff": 6, "\U00010000": 7, "\ue000": 8},
        {"nested": {"z": [3, 2, 1], "a": {"y": None, "x": True}}, "list": [{"b": 1, "a": 2}, [], {}]},
        {"numbers": [0, -1, 1, 42, 9007199254740991, -9007199254740991, 0.5, -0.25, 3.14159, 1e-05, 1.5e-07, 0.0001, 123.456, 1e21, 1.5e300, -2.5e-300, 1e100]},
        {"floats": [0.1, 0.2, 0.30000000000000004, 1 / 3, 2 / 3, 5e-324, 1.7976931348623157e308, 0.00012, 0.000012, 123456789.123]},
        {"bools": [True, False, None], "empty": "", "zero": 0},
        {"text": "line\nbreak\ttab\r\u0008\u000c\u0001\u001f\u007f\u2028\u2029\"\\/"},
        {"unicode": "中文 emoji😀 combining e\u0301 rtl \u05d0"},
        {"long": LONG_ASCII, "longCjk": LONG_CJK},
        {"model_id": "claude-opus-4-1", "effort_id": "high"},
        {"model_id": "claude-opus-4-1"},
        {"permission_id": "bypassPermissions"},
        {"sandbox": {"mode": "workspace-write", "network": False}, "approval": "on-request"},
        [1, "a", None],
        "bare-string",
        None,
        12,
    ]
    vectors = []
    for identity in identities:
        identity = _wire(identity)
        for runtime, catalog_type in (("codex", "model"), ("claude", "permission")):
            vectors.append(_vector(
                {"runtime": runtime, "catalogType": catalog_type, "identity": identity},
                _call(protocol_selection_id, runtime, catalog_type, identity),
            ))
    for runtime, catalog_type in (("中文", "model"), ("a:b", "c:d"), ("", ""), ("codex", "permission"), ("dsh", "😀")):
        vectors.append(_vector(
            {"runtime": runtime, "catalogType": catalog_type, "identity": {"k": "v"}},
            _call(protocol_selection_id, runtime, catalog_type, {"k": "v"}),
        ))
    result["selection.protocolSelectionId"] = _category(
        "connector/connector/server/protocol.py:protocol_selection_id",
        "sel_{catalogType}_{base64url_nopad(sha256(utf8('1:' + runtime + ':' + catalogType + ':' + canonicalJson(identity))))[:24]}; "
        "canonicalJson = json.dumps(sort_keys=True, ensure_ascii=False, separators=(',', ':')) (keys sorted by code point, Python float repr).",
        vectors,
    )

    vectors = []
    for runtime in ("codex", "claude", "pi", "dsh"):
        for model_id, effort_id in (("gpt-5", None), ("gpt-5", "high"), ("模型", "高"), ("m:1", ""), ("", None), ("😀", "e\u0301")):
            vectors.append(_vector(
                {"runtime": runtime, "modelId": model_id, "effortId": effort_id},
                _call(custom_models.custom_model_selection_id, runtime, model_id, effort_id),
            ))
    result["selection.customModelSelectionId"] = _category(
        "connector/connector/runtimes/custom_models.py:custom_model_selection_id",
        "codex: identity {model_id, reasoning_id}; others: {model_id, effort_id} when effortId is not None, else {model_id}; catalogType 'model'.",
        vectors,
    )

    vectors = []
    for permission_id in ("default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto", *NON_EMPTY[:15], ""):
        vectors.append(_vector({"permissionId": permission_id}, _call(claude_permissions._selection_id, permission_id)))
    result["selection.claudePermissionSelectionId"] = _category(
        "connector/connector/runtimes/claude/domain/permissions.py:_selection_id",
        "protocol_selection_id('claude', 'permission', {permission_id}).",
        vectors,
    )

    vectors = []
    for provider, model, effort in [
        ("deepseek", "deepseek-chat", None),
        ("deepseek", "deepseek-reasoner", "high"),
        ("openai", "gpt-5", "medium"),
        ("中文", "模型", "高"),
        ("p", "m", ""),
        ("", "m", None),
        ("p", "", None),
        ("😀", "🎉", "🧑‍💻"),
        ("a\"b", "c\\d", "e/f"),
        ("nul\u0000", "m", None),
        ("p", "line\nbreak", "tab\t"),
        ("p", LONG_ASCII, None),
        ("p", LONG_CJK, "x"),
        ("\uffff", "\U0010ffff", None),
        ("a:b", "c:d", "e:f"),
        ("p", "m", "e\u0301"),
        ("P", "M", "E"),
        ("p", "m?x=1&y=2", None),
        ("p", "m", "ü"),
        ("provider", "model with spaces", "very high"),
    ]:
        vectors.append(_vector(
            {"provider": provider, "model": model, "effort": effort},
            _call(dsh_identity.model_selection_id, provider, model, effort),
        ))
    result["selection.dshModelSelectionId"] = _category(
        "connector/connector/runtimes/dsh/identity.py:model_selection_id",
        "'dsh:model:' + base64url_nopad(utf8(json.dumps([provider, model, effort], ensure_ascii=False, separators=(',', ':')))); "
        "empty provider/model or empty-string effort raises ValueError.",
        vectors,
    )

    vectors = []
    for preset in ("default", "plan", "yolo", "中文", "😀", "a:b", "nul\u0000", "", LONG_ASCII, "e\u0301", *NON_EMPTY[:12]):
        vectors.append(_vector({"preset": preset}, _call(dsh_identity.permission_selection_id, preset)))
    result["selection.dshPermissionSelectionId"] = _category(
        "connector/connector/runtimes/dsh/identity.py:permission_selection_id",
        "'dsh:permission:' + base64url_nopad(utf8(preset)); empty raises ValueError.",
        vectors,
    )

    vectors = []
    for model, effort in [
        ("gpt-5", "high"),
        ("claude", "low"),
        ("模型", "高"),
        ("😀", "🎉"),
        ("a\"b", "c\\d"),
        ("line\nbreak", "\u0001"),
        ("", ""),
        ("m", None),
        (None, "e"),
        ("\u007f\u0080\u00ff", "\u0100"),
        ("\uffff", "\U0010ffff"),
        ("e\u0301", "\u00e9"),
        (LONG_ASCII, "x"),
        (LONG_CJK, "y"),
        ("a", "b"),
        ("ab", "c"),
        ("abc", "d"),
        ("abcd", "e"),
        ("m/1+2", "e?=&"),
        ("\u2028", "\u2029"),
    ]:
        vectors.append(_vector({"model": model, "effort": effort}, _call(acp_catalogs.selection_id, model, effort)))
    result["selection.acpSelectionId"] = _category(
        "connector/connector/runtimes/acp/domain/catalogs.py:selection_id",
        "'acp-selection:' + base64url WITH '=' padding of json.dumps([model, effort], separators=(',', ':')) using the DEFAULT ensure_ascii=True "
        "(non-ASCII escaped as lowercase \\uXXXX, astral characters as surrogate pairs).",
        vectors,
    )
    result["selection.catalogs"] = _category(
        "connector/connector/runtimes/codex/domain/catalogs.py, connector/connector/runtimes/claude/domain/{models,permissions}.py",
        "Selection ids of the real built-in catalogs (the ids stored in existing sessions and preferences). kind=codexPermission: "
        "protocol_selection_id('codex', 'permission', item.identity or {permission_id}); kind=codexModel: reasoning items use "
        "{model_id, reasoning_id}, a model without reasoning items uses reasoning_id null; kind=claudePermission / claudeModel / "
        "claudeEffort: the Claude static tables.",
        _catalog_vectors(),
    )
    return result


def _catalog_vectors() -> list[dict[str, Any]]:
    vectors = []
    codex_items = codex_catalogs.codex_permission_catalog_items()
    by_id = {item["id"]: item for item in codex_items}
    for permission in codex_catalogs.permission_catalog_from_codex_items(codex_items, 1).permissions:
        identity = by_id[permission.id].get("identity")
        vectors.append(_vector(
            {"kind": "codexPermission", "id": permission.id, "identity": identity if isinstance(identity, dict) else None},
            {"output": permission.selection_id},
        ))
    raw_models = [
        {"id": "gpt-5.1-codex", "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "medium"}, {"reasoningEffort": "high"}]},
        {"id": "gpt-5", "supportedReasoningEfforts": ["minimal", "low", "medium", "high"]},
        {"model": "o4-mini"},
        {"id": "模型😀", "efforts": ["高"]},
        {"id": "custom:model/1", "reasoningEfforts": []},
    ]
    for model in codex_catalogs.model_catalog_from_codex_items(raw_models, 1).models:
        vectors.append(_vector(
            {"kind": "codexModel", "modelId": model.id, "reasoningIds": [item.id for item in model.reasoning_items]},
            {"output": {"selectionId": model.selection_id, "reasoning": [item.selection_id for item in model.reasoning_items]}},
        ))
    for permission in claude_permissions.claude_permission_catalog(1).permissions:
        vectors.append(_vector({"kind": "claudePermission", "id": permission.id}, {"output": permission.selection_id}))
    for model in claude_models.claude_model_catalog(1).models:
        vectors.append(_vector({"kind": "claudeModel", "modelId": model.id}, {"output": model.selection_id}))
        for effort in model.reasoning_items:
            vectors.append(_vector(
                {"kind": "claudeEffort", "modelId": model.id, "effortId": effort.id},
                {"output": effort.selection_id},
            ))
    return vectors


# ---------------------------------------------------------------------------
# Timeline identity
# ---------------------------------------------------------------------------


def codex_categories() -> dict[str, Any]:
    result: dict[str, Any] = {}

    vectors = []
    for external in ("thread-1", "", "中文", "a\u0000b", LONG_ASCII):
        for client in ("client-1", "", "😀", "x\u0000y"):
            vectors.append(_vector(
                {"externalSessionId": external, "clientMessageId": client},
                _call(codex_identity.client_message_item_id, external, client),
            ))
    result["timeline.codexClientMessageItemId"] = _category(
        "connector/connector/runtimes/codex/timeline/identity.py:client_message_item_id",
        "codex_item_ + sha256(utf8('codex-client-message-v1\\0' + externalSessionId + '\\0' + clientMessageId)).hex[:32].",
        vectors,
    )

    vectors = []
    for external, turn, position, lane in [
        ("thread-1", "turn-1", 0, "assistant-message"),
        ("thread-1", "turn-1", 1, "assistant-message"),
        ("thread-1", "turn-1", 0, "user-message"),
        ("thread-1", "turn-1", 0, "reasoning"),
        ("thread-1", "turn-1", 0, "tool:commandExecution"),
        ("thread-1", "turn-1", 3, "system:systemMessage"),
        ("thread-1", "turn-1", 0, "item:unknown"),
        ("thread-1", "turn-1", 999999, "tool:mcpToolCall"),
        ("", "", 0, ""),
        ("中文", "回合", 2, "tool:中文"),
        ("a\u0000b", "c", 0, "assistant-message"),
        ("a", "b\u0000c", 0, "assistant-message"),
        (LONG_ASCII, LONG_CJK, 7, "assistant-message"),
        ("😀", "🎉", 0, "tool:😀"),
        ("thread-1", "turn-2", 0, "assistant-message"),
        ("thread-2", "turn-1", 0, "assistant-message"),
        ("thread-1", "turn-1", 9007199254740991, "assistant-message"),
        ("thread-1", "turn-1", -1, "assistant-message"),
        ("t", "u", 10, "tool:dynamicToolCall"),
        ("t", "u", 10, "tool:collabAgentToolCall"),
    ]:
        vectors.append(_vector(
            {"externalSessionId": external, "turnId": turn, "position": position, "lane": lane},
            _call(codex_identity.turn_position_item_id, external, turn, position, lane),
        ))
    vectors.append(_vector(
        {"externalSessionId": "thread-1", "turnId": "turn-1", "position": 0, "lane": None},
        _call(codex_identity.turn_position_item_id, "thread-1", "turn-1", 0),
        name="default lane is assistant-message",
    ))
    result["timeline.codexTurnPositionItemId"] = _category(
        "connector/connector/runtimes/codex/timeline/identity.py:turn_position_item_id",
        "codex_item_ + sha256(utf8('codex-turn-item-v2\\0' + ext + '\\0' + turn + '\\0' + lane + '\\0' + str(position))).hex[:32]; lane defaults to 'assistant-message' (input lane null).",
        vectors,
    )

    raw_types = ["agentMessage", "message", "userMessage", "steeringUserMessage", "reasoning", "commandExecution",
                 "systemMessage", "plan", "contextCompaction", "runtimeMessage", "turnEnd", "turnStart", "webSearch", "custom"]
    roles = [None, "user", "assistant", "tool", "system", "other", ""]
    vectors = []
    for raw_type in raw_types:
        for role in roles:
            vectors.append(_vector(
                {"rawType": raw_type, "role": role},
                {"output": {
                    "lane": codex_identity.turn_item_lane(raw_type, role),
                    "usesTurnPositionIdentity": codex_identity.uses_turn_position_identity(raw_type, role),
                    "isUserMessage": codex_identity.is_user_message_values(raw_type, role),
                }},
            ))
    result["timeline.codexTurnItemLane"] = _category(
        "connector/connector/runtimes/codex/timeline/identity.py:turn_item_lane, uses_turn_position_identity, is_user_message_values",
        "Lane, whether the turn-position identity applies, and whether client-message identity may bind.",
        vectors,
    )

    vectors = []
    sequences = [
        ["assistant-message"],
        ["assistant-message", "assistant-message", "assistant-message"],
        ["reasoning", "assistant-message", "reasoning", "assistant-message"],
        ["reasoning", "reasoning", "reasoning"],
        ["user-message", "reasoning", "assistant-message", "tool:commandExecution", "assistant-message"],
        ["tool:commandExecution", "tool:commandExecution", "tool:webSearch", "tool:commandExecution"],
        ["assistant-message", "reasoning", "reasoning", "assistant-message", "reasoning"],
        [],
        ["system:systemMessage", "item:custom", "system:systemMessage"],
        ["user-message", "user-message"],
    ]
    for index in range(10):
        sequences.append([["assistant-message", "reasoning", "tool:x", "user-message"][(index * 7 + step * 3) % 4] for step in range(index + 3)])
    for lanes in sequences:
        state: dict[str, int] = {}
        positions = [codex_identity.next_turn_lane_position(state, lane) for lane in lanes]
        vectors.append(_vector({"lanes": lanes}, {"output": positions}))
    result["timeline.codexNextTurnLanePosition"] = _category(
        "connector/connector/runtimes/codex/timeline/identity.py:next_turn_lane_position",
        "Per-turn lane counters starting from an empty map; 'reasoning' shares the current assistant-message position without advancing.",
        vectors,
    )

    vectors = []
    value_cases = [
        ("reasoning", None, "turn-1", 3),
        ("agentMessage", "assistant", "turn-1", 0),
        ("agentMessage", None, None, 5),
        ("commandExecution", "tool", "turn-1", 2),
        ("", None, None, 0),
        ("", "", "", 7),
        ("中文类型", "角色", "回合", 1),
        ("a.b/c:d", "x y", "t\u0000u", 4),
        ("😀", "🎉", "🧑‍💻", 9),
        ("e\u0301", "\u00b2", "\u0660\u0661", 0),
        (LONG_ASCII, "assistant", "turn", 1),
        ("snake_case-kebab", "role-x", "turn_1", 12),
        ("ﬁ", "Ⅻ", "ǅ", 3),
        ("", "", "t", 0),
        ("type", None, "", 0),
        ("\u200b\u00a0", "\t", "\n", 2),
        ("x", None, LONG_CJK, 8),
        ("𝐀𝟎", "ᎠꭰAa", "ı", 11),
        ("mcpToolCall", "tool", "019a8f5e-6a1d", 4),
        ("userMessage", "user", "turn-1", 0),
    ]
    for raw_type, role, turn_id, index in value_cases:
        vectors.append(_vector(
            {"rawType": raw_type, "role": role, "turnId": turn_id, "index": index},
            _call(codex_identity.derived_key_from_values, raw_type, role, turn_id, index),
        ))
    result["timeline.codexDerivedKeyFromValues"] = _category(
        "connector/connector/runtimes/codex/timeline/identity.py:derived_key_from_values",
        "reasoning -> 'reasoning-{index}'; else '-'.join(_safe_component(p) for p in [rawType, role or '', turnId or '', str(index)] if p) "
        "or 'item-{index}'. _safe_component keeps Python str.isalnum() code points (Unicode letters/numbers), '_' and '-', "
        "replaces every other code point with '_', then keeps the first 96 code points.",
        vectors,
    )

    vectors = []
    for native_id, client_id, raw_type, role, turn_id, external, index in [
        (None, "client-1", "userMessage", None, "turn-1", "thread-1", 0),
        (None, "client-1", "agentMessage", "user", "turn-1", "thread-1", 0),
        (None, "client-1", "agentMessage", "assistant", "turn-1", "thread-1", 0),
        ("item-1", "client-1", "agentMessage", "assistant", "turn-1", "thread-1", 0),
        ("item-1", "client-1", "userMessage", None, "turn-1", "thread-1", 0),
        ("item-1", None, "userMessage", None, "turn-1", "thread-1", 0),
        (None, None, "reasoning", None, "turn-1", "thread-1", 4),
        (None, None, "commandExecution", "tool", "turn-1", "thread-1", 2),
        (None, "", "steeringUserMessage", None, "turn-1", "thread-1", 1),
        (None, "c", "steeringUserMessage", None, None, "thread-1", 1),
        (None, None, "", None, None, "", 0),
        (None, None, "中文", "角色", "回合", "会话", 3),
        ("", None, "agentMessage", None, None, "t", 0),
        (None, None, "agentMessage", None, None, "a\u0000b", 0),
        (None, "😀", "userMessage", "user", None, "😀", 0),
        (None, None, "x", None, None, LONG_ASCII, 1),
        (None, "c", "message", "user", "turn", "ext", 6),
        (None, None, "message", "assistant", "turn", "ext:with:colon", 6),
        ("native/with/slash", None, "x", None, None, "ext", 0),
        (None, None, "toolCall", "tool", "t", "ext", 10),
    ]:
        vectors.append(_vector(
            {"nativeId": native_id, "clientMessageId": client_id, "rawType": raw_type, "role": role,
             "turnId": turn_id, "externalSessionId": external, "index": index},
            _call(codex_identity.timeline_item_id_from_values, native_id, client_id, raw_type, role, turn_id, external, index),
        ))
    result["timeline.codexTimelineItemIdFromValues"] = _category(
        "connector/connector/runtimes/codex/timeline/identity.py:timeline_item_id_from_values",
        "client message binding (truthy clientMessageId on a user message) > nativeId (when not None) > 'codex_{ext}_{derived_key_from_values}'.",
        vectors,
    )

    vectors = []
    raws: list[dict[str, Any]] = [
        {"type": "userMessage", "clientMessageId": "c1"},
        {"type": "userMessage", "_clientMessageId": "c0", "clientMessageId": "c1"},
        {"type": "userMessage", "_clientMessageId": 5, "clientMessageId": "c1"},
        {"type": "userMessage", "_clientMessageId": "", "clientMessageId": "c1"},
        {"type": "userMessage", "clientId": "c2"},
        {"type": "userMessage", "client_id": "c3", "id": "native"},
        {"type": "agentMessage", "clientMessageId": "c1", "id": "native"},
        {"role": "user", "type": "message", "clientMessageId": "c1"},
        {"id": "item-1"},
        {"id": "", "itemId": "item-2"},
        {"id": 7, "item_id": "item-3"},
        {"type": "reasoning", "turnId": "t"},
        {"type": "commandExecution", "turnId": "t", "role": "tool"},
        {"type": "commandExecution", "turn_id": "t"},
        {"kind": "webSearch", "turnId": "t"},
        {"type": "plan", "turnId": "t"},
        {"type": "", "kind": "systemMessage"},
        {},
        {"type": 5, "turnId": "t"},
        {"type": "x", "_derivedKey": "explicit-key"},
        {"type": "x", "_derivedKey": "", "derivedKey": "dk"},
        {"type": "x", "derived_key": "d k/中文"},
        {"type": "中文", "turnId": "回合", "role": "角色"},
        {"type": "😀", "role": ""},
        {"type": "turnStart"},
        {"type": "agentMessage", "role": "assistant", "turnId": LONG_ASCII},
    ]
    for raw in raws:
        for external, index in (("thread-1", 0), ("会话:1", 3)):
            vectors.append(_vector(
                {"raw": raw, "externalSessionId": external, "index": index},
                _call(codex_identity.timeline_item_id, raw, external, index),
            ))
    result["timeline.codexTimelineItemId"] = _category(
        "connector/connector/runtimes/codex/timeline/identity.py:timeline_item_id",
        "Raw-dict variant. clientMessageId = first truthy of _clientMessageId/clientMessageId/clientId/client_id, used only if it is a non-empty "
        "string; explicit derived key = first truthy of _derivedKey/derivedKey/derived_key; type = first truthy of type/kind or 'item' "
        "(str() applied); role via timeline_item_role (raw role, else inferred from type with plan->systemMessage).",
        vectors,
    )

    vectors = []
    for call_id in ("call_1", "", "中文", "😀", "a\u0000b", "a:b/c", LONG_ASCII, LONG_EMOJI, *NON_EMPTY[:12]):
        vectors.append(_vector(
            {"callId": call_id},
            {"output": {
                "noticeId": codex_input_requests.async_input_notice_id(call_id),
                "clientMessageId": codex_input_requests.async_input_client_message_id(call_id),
                "timelineItemId": codex_input_requests.async_input_timeline_item_id(call_id),
            }},
        ))
    result["timeline.codexAsyncInputIds"] = _category(
        "connector/connector/runtimes/codex/domain/input_requests.py:async_input_notice_id, async_input_client_message_id, async_input_timeline_item_id",
        "sha256(utf8(callId)).hex[:32] with prefixes notice_codex_async_input_, codex_async_input_, codex_async_input_item_.",
        vectors,
    )
    return result


def claude_categories() -> dict[str, Any]:
    result: dict[str, Any] = {}
    sessions = [
        ("sess_claude_1", "019a8f5e-6a1d-7c2b-9e3f-0123456789ab"),
        ("sess_claude_1", None),
        ("sess_claude_1", ""),
        ("会话", "外部😀"),
        ("s", "a\u0000b"),
    ]
    natives = ["msg_01ABC", "", "中文", "a\"b\\c", LONG_ASCII, "uuid:with:colon"]
    vectors = []
    for session_id, external in sessions:
        for native in natives:
            session = ClaudeSession(session_id=session_id, external_session_id=external)
            vectors.append(_vector(
                {"sessionId": session_id, "externalSessionId": external, "nativeMessageId": native},
                {"output": {
                    "message": claude_messages.stable_message_item_id(session, native),
                    "tool": claude_messages.stable_tool_item_id(session, native),
                }},
            ))
    result["timeline.claudeMessageAndToolItemId"] = _category(
        "connector/connector/runtimes/claude/timeline/messages.py:stable_message_item_id, stable_tool_item_id",
        "scope = externalSessionId or sessionId (Python truthiness: '' and null fall back). message: 'claude_msg_' + short('message', scope, id); "
        "tool: 'claude_tool_' + short('tool', scope, toolUseId); short(*parts) = sha256(utf8(json.dumps(list(parts), ensure_ascii=False, "
        "sort_keys=True, separators=(',', ':')))).hex[:24].",
        vectors,
    )

    vectors = []
    for session_id, external in sessions[:4]:
        for turn_id, native, index, block_type in [
            ("turn_1", "msg_1", 0, "text"),
            ("turn_1", None, 2, "compact_boundary"),
            ("turn_1", "", 1, "status"),
            ("回合", "消息", 3, "类型😀"),
            ("t", "m", 0, ""),
        ]:
            session = ClaudeSession(session_id=session_id, external_session_id=external)
            block = claude_messages.ClaudeSystemBlock(block_type=block_type, block_index=index)
            vectors.append(_vector(
                {"sessionId": session_id, "externalSessionId": external, "turnId": turn_id, "nativeMessageId": native,
                 "blockIndex": index, "blockType": block_type},
                {"output": claude_messages.stable_system_item_id(session=session, turn_id=turn_id, native_message_id=native, block=block)},
            ))
    result["timeline.claudeSystemItemId"] = _category(
        "connector/connector/runtimes/claude/timeline/messages.py:stable_system_item_id",
        "'claude_system_' + short('system', scope, nativeMessageId or turnId, blockIndex, blockType).",
        vectors,
    )

    vectors = []
    for parts in [
        ["message", "sess", "ext", "turn", "user", "client-1"],
        ["message", "sess", None, "turn", "assistant", "text body"],
        ["message", "sess", "", "turn", "user", ""],
        ["api-retry", "sess", "turn_claude_x"],
        ["message", "会话", "外部", "回合", "user", "中文😀"],
        ["message", "s", "e", "t", "user", LONG_CJK],
        ["tool", "ClaudeToolBlock(...)"],
        ["x"],
        [],
        ["a", 1, 2.5, True, None],
        ["nested", {"b": 1, "a": [1, {"d": None, "c": "x"}]}],
        ["quote\"back\\slash\n"],
        ["\u0000", "\u001f", "\u007f"],
        ["\uffff", "\U00010000"],
        ["api-retry", "", ""],
        ["message", "sess", "ext", "turn", "system", "e\u0301"],
        ["message", "a:b", "c:d", "e:f", "g", "h"],
        ["1e-05", 1e-05, 0.0001, 1e21],
        [LONG_ASCII],
        ["message", "sess", "ext", "turn", "user", "client-1", "extra"],
    ]:
        parts = _wire(parts)
        vectors.append(_vector({"parts": parts}, {"output": claude_messages._stable_id(*parts)}))
    result["timeline.claudeStableId"] = _category(
        "connector/connector/runtimes/claude/timeline/messages.py:_stable_id",
        "'claude_' + short(*parts). Used for the message fallback ('message', sessionId, externalSessionId|null, turnId, role, "
        "nativeId or clientMessageId or text) and API retry items ('api-retry', sessionId, turnId).",
        vectors,
    )

    vectors = []
    for external in ("ext-1", None, "", "中文", "a:b"):
        for seed in ("msg_1", "ext-1:0", "ext-1:initial", "😀"):
            vectors.append(_vector({"externalSessionId": external, "turnSeed": seed}, {"output": claude_reader._history_turn_id(external, seed)}))
    result["timeline.claudeHistoryTurnId"] = _category(
        "connector/connector/runtimes/claude/sessions/reader.py:_history_turn_id",
        "turn_claude_ + sha256(utf8((externalSessionId or 'unknown') + ':' + turnSeed)).hex[:24]. Live turns use a random token instead.",
        vectors,
    )
    return result


def acp_categories() -> dict[str, Any]:
    result: dict[str, Any] = {}

    def chunk(kind, text, *, message_id=None, verified=False, meta=None, content_type="text"):
        update: dict[str, Any] = {"sessionUpdate": kind, "content": {"type": content_type, "text": text}}
        if message_id is not None:
            update["messageId"] = message_id
        if verified:
            update["aaProjectionVerified"] = True
        if meta is not None:
            update["_meta"] = {"aa": meta}
        return update

    def tool(kind, tool_id, *, verified=False, status="in_progress"):
        update: dict[str, Any] = {"sessionUpdate": kind, "toolCallId": tool_id, "status": status, "title": "t"}
        if verified:
            update["aaProjectionVerified"] = True
        return update

    def native(item_id, revision, *, verified=True, item_type="message", update_kind="agent_message_chunk"):
        update: dict[str, Any] = {
            "sessionUpdate": update_kind,
            "content": {"type": "text", "text": "x"},
            "_meta": {"aa": {"timelineItem": {
                "id": item_id, "type": item_type, "role": "assistant", "status": "done", "revision": revision,
                "content": {"kind": "markdown", "text": "x"}, "source": {"origin": "agent"}, "orderSeq": 1,
            }}},
        }
        if verified:
            update["aaProjectionVerified"] = True
        return update

    scenarios: list[tuple[str, list[dict[str, Any]]]] = [
        ("verified chunks share messageId", [chunk("agent_message_chunk", "a", message_id="m1", verified=True), chunk("agent_message_chunk", "b", message_id="m1", verified=True)]),
        ("unverified chunks use epoch + index", [chunk("agent_message_chunk", "a"), chunk("agent_message_chunk", "b")]),
        ("kind switch advances index", [chunk("agent_thought_chunk", "t"), chunk("agent_message_chunk", "a"), chunk("agent_thought_chunk", "t2"), chunk("agent_message_chunk", "b")]),
        ("unverified messageId is ignored", [chunk("agent_message_chunk", "a", message_id="m1"), chunk("agent_message_chunk", "b", message_id="m2")]),
        ("empty messageId falls back to index", [chunk("agent_message_chunk", "a", message_id="", verified=True), chunk("user_message_chunk", "u", message_id="", verified=True)]),
        ("non-text content still advances index", [chunk("agent_message_chunk", "img", content_type="image"), chunk("agent_thought_chunk", "t"), chunk("agent_message_chunk", "a")]),
        ("tool resets kind", [chunk("agent_message_chunk", "a"), tool("tool_call", "call-1"), chunk("agent_message_chunk", "b")]),
        ("verified tool ids", [tool("tool_call", "call-1", verified=True), tool("tool_call_update", "call-1", verified=True, status="completed")]),
        ("unverified tool ids include epoch", [tool("tool_call", "call-1"), tool("tool_call_update", "call-1", status="completed")]),
        ("unknown updates return null and keep kind", [chunk("agent_message_chunk", "a"), {"sessionUpdate": "plan", "entries": []}, chunk("agent_message_chunk", "b"), {"sessionUpdate": "session_info_update"}, chunk("agent_thought_chunk", "t")]),
        ("native timelineItem wins when verified", [native("native-1", 1), native("native-1", 2), native("native-1", 2), native("native-1", 1), native("native-2", 1)]),
        ("native timelineItem ignored when unverified", [native("native-1", 1, verified=False), native("native-1", 2, verified=False)]),
        ("native tool type", [native("tool-native", 1, item_type="tool", update_kind="tool_call")]),
        ("invalid native type raises", [native("bad", 1, item_type="system")]),
        ("invalid native id raises", [native(5, 1)]),
        ("user message with clientMessageId", [chunk("user_message_chunk", "hello", message_id="client-1", verified=True, meta={"clientMessageId": "client-1", "boundary": True})]),
        ("unicode identifiers", [chunk("agent_message_chunk", "a", message_id="消息😀", verified=True), tool("tool_call", "工具:1/2", verified=True), tool("tool_call", "工具:1/2")]),
        ("numeric messageId", [chunk("agent_message_chunk", "a", message_id=42, verified=True), chunk("agent_message_chunk", "b", message_id=0, verified=True)]),
        ("verified then unverified same messageId", [chunk("agent_message_chunk", "a", message_id="m", verified=True), chunk("agent_message_chunk", "b", message_id="m")]),
        ("long run", [chunk(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"][i % 3], str(i)) for i in range(12)]),
        ("tool update before call", [tool("tool_call_update", "late", verified=True), tool("tool_call", "late", verified=True)]),
        ("native does not reset message kind", [chunk("agent_message_chunk", "a"), native("n", 1), chunk("agent_message_chunk", "b"), chunk("agent_thought_chunk", "c")]),
    ]
    vectors = []
    for session_id, epoch in (("sess_pi_1", "epoch-1"), ("会话", "e\u0000poch")):
        for name, updates in scenarios:
            updates = _wire(updates)
            projection = Projection(session_id, epoch, runtime_type="pi")
            ids: list[Any] = []
            for update in updates:
                try:
                    item = projection.apply(update)
                except Exception as error:  # noqa: BLE001 -- the error is the vector
                    ids.append({"error": type(error).__name__})
                    break
                ids.append(item["id"] if item else None)
            vectors.append(_vector({"sessionId": session_id, "epoch": epoch, "updates": updates}, {"output": ids}, name=name))
    result["timeline.acpProjectionItemId"] = _category(
        "connector/connector/runtimes/acp/infrastructure/projection.py:Projection.apply",
        "Drives a fresh Projection(sessionId, epoch) with the updates; output is the item id per update (null when apply returns None; "
        "{error} ends the sequence). Verified _meta.aa.timelineItem wins (stale revisions return null); verified messageId/toolCallId give "
        "fingerprint([sessionId, kind, messageId]) / fingerprint([sessionId, 'tool', toolCallId]); otherwise connection-local "
        "fingerprint([sessionId, epoch, kind, messageIndex]) / fingerprint([sessionId, epoch, 'tool', toolCallId]).",
        vectors,
    )

    entries_sets: list[tuple[str, list[dict[str, Any]]]] = [
        ("messages and tools", [
            {"type": "message", "id": "e1", "parentId": None, "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}},
            {"type": "message", "id": "e2", "parentId": "e1", "message": {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "hmm"}, {"type": "text", "text": "ok"},
                {"type": "toolCall", "id": "call-1", "name": "bash", "arguments": {"command": "ls"}}]}},
            {"type": "message", "id": "e3", "message": {"role": "toolResult", "toolCallId": "call-1", "content": [{"type": "text", "text": "out"}]}},
            {"type": "message", "id": "e4", "message": {"role": "toolResult", "toolCallId": "missing", "toolName": "read", "content": "x"}},
            {"type": "message", "id": "e5", "message": {"role": "bashExecution", "command": "pwd", "output": "/", "exitCode": 0}},
        ]),
        ("legacy entries without ids", [
            {"type": "message", "message": {"role": "user", "content": "legacy text"}, "timestamp": "2025-01-01T00:00:00Z"},
            {"type": "message", "id": "", "message": {"role": "assistant", "content": [{"type": "text", "text": "a"}], "usage": {"cost": 0.0123, "input": 12}}},
            {"type": "compaction", "summary": "summary text", "tokensBefore": 1234},
            {"type": "branch_summary", "summary": "branch", "fromId": "x"},
            {"type": "custom_message", "content": [{"type": "text", "text": "custom"}], "score": 1.5e-07},
        ]),
        ("unicode", [
            {"type": "message", "id": "条目😀", "message": {"role": "user", "content": [{"type": "text", "text": "中文"}, {"type": "image", "data": "..."}]}},
            {"type": "message", "id": "a:b/c", "message": {"role": "custom", "content": [{"type": "text", "text": "c"}]}},
            {"type": "custom_message", "id": "n\u0000ul", "content": "text"},
            {"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "é"}], "meta": {"é": 1, "e": 2, "😀": 3, "\uffff": 4}}},
        ]),
    ]
    vectors = []
    for session_id in ("pi_native_" + "0" * 40, "sess_pi_会话"):
        for _name, entries in entries_sets:
            entries = _wire(entries)
            history = pi_history.NativeHistory(Path("/h.jsonl"), {"id": "native-1"}, tuple(entries), "rev", True)
            for item in pi_history.timeline(history, session_id):
                suffix = _suffix(item)
                entry_index = _entry_index(entries, session_id, suffix, item["id"])
                vectors.append(_vector(
                    {"sessionId": session_id, "entryIndex": entry_index, "entry": entries[entry_index], "suffix": suffix},
                    {"output": item["id"]},
                ))
    result["timeline.piHistoryItemId"] = _category(
        "connector/connector/runtimes/acp/profiles/pi/history.py:timeline",
        "Pi native history: fingerprint([sessionId, 'pi', entry.id or f'legacy:{entryIndex}:{fingerprint(entry)}', suffix]); suffix is the "
        "content-block index (number) for message blocks, else 'result' | 'bash' | entry type (string). Outputs come from running the real "
        "timeline() over the entries.",
        vectors,
    )
    return result


def _entry_index(entries: list[dict[str, Any]], session_id: str, suffix: Any, item_id: str) -> int:
    """Locate the entry that produced item_id (the id itself comes from the real timeline())."""

    matches = [
        index for index, entry in enumerate(entries)
        if fingerprint([session_id, "pi", entry.get("id") or f"legacy:{index}:{fingerprint(entry)}", suffix]) == item_id
    ]
    if len(matches) != 1:
        raise AssertionError(f"cannot attribute Pi item {item_id}: {matches}")
    return matches[0]


def _suffix(item: dict[str, Any]) -> Any:
    derived = item["source"]["derivedKey"]
    return int(derived) if derived.isdigit() else derived


def dsh_python_categories() -> dict[str, Any]:
    vectors = []
    for external, kind, business in [
        ("ext-1", "tool", "call-1"),
        ("ext-1", "message", "seq:3"),
        ("ext-1", "turn", "12"),
        ("ext-1", "approval", "evt-1"),
        ("ext-1", "question", "evt-2"),
        ("ext-1", "turn-outcome", "40"),
        ("", "tool", "x"),
        ("e", "", "x"),
        ("e", "tool", ""),
        ("中文", "工具", "调用😀"),
        ("a\u0000b", "c", "d"),
        ("a", "b\u0000c", "d"),
        (LONG_ASCII, "tool", LONG_CJK),
        ("e", "tool", "a:b/c\\d"),
        ("sess_dsh_0123", "approval", "evt"),
        ("e", "reasoning", "seq:1:0"),
        ("e", "message", "seq:1:1"),
        ("\uffff", "\U00010000", "\U0010ffff"),
        ("e\u0301", "tool", "\u00e9"),
        ("x", "y", "z"),
    ]:
        vectors.append(_vector(
            {"externalSessionId": external, "kind": kind, "businessId": business},
            _call(dsh_identity.timeline_item_id, external, kind, business),
        ))
    return {"timeline.dshTimelineItemId": _category(
        "connector/connector/runtimes/dsh/identity.py:timeline_item_id",
        "dsh_ + sha256(utf8(ext + '\\0' + kind + '\\0' + businessId)).hex (full 64 chars); any empty component raises ValueError. "
        "Same algorithm as the plugin itemId().",
        vectors,
    )}


def planning_categories() -> dict[str, Any]:
    vectors = []
    for prefix, parts in [
        ("plan_", ["sess_codex_1", "native-1"]),
        ("draft_", ["sess_codex_1", "native-1"]),
        ("review_", ["plan_abc", "1"]),
        ("review_", ["plan_abc", "12"]),
        ("plan_", ["sess", ""]),
        ("plan_", ["", ""]),
        ("plan_", []),
        ("plan_", ["only"]),
        ("plan_", ["a\u0000b", "c"]),
        ("plan_", ["a", "b\u0000c"]),
        ("plan_", ["中文", "😀"]),
        ("", ["x"]),
        ("prefix:with:colon_", ["a", "b"]),
        ("plan_", [LONG_ASCII, LONG_CJK]),
        ("draft_", ["s", "n", "extra"]),
        ("review_", ["plan_x", "0"]),
        ("plan_", ["e\u0301", "\u00e9"]),
        ("plan_", ["\uffff", "\U00010000"]),
        ("plan_", ["a:b", "c/d"]),
        ("draft_", ["sess_claude_1", "toolu_01"]),
    ]:
        vectors.append(_vector({"prefix": prefix, "parts": parts}, {"output": planning_session.stable_id(prefix, *parts)}))
    return {"planning.stableId": _category(
        "connector/connector/planning/domain/session.py:stable_id",
        "prefix + sha256(utf8('\\0'.join(parts))).hex[:32]; used for plan_ (sessionId, nativeId), draft_ (sessionId, nativeId), review_ (planId, str(version)).",
        vectors,
    )}


# ---------------------------------------------------------------------------
# DSH plugin (TypeScript, dsh-bridge-next)
# ---------------------------------------------------------------------------

_NODE_DRIVER = r"""
import { pathToFileURL } from 'node:url'
const identity = await import(pathToFileURL(process.argv[1]).href)
let input = ''
for await (const chunk of process.stdin) input += chunk
const results = JSON.parse(input).map(([fn, args]) => {
  try {
    const output = identity[fn](...args)
    return output === undefined ? { output: null } : { output }
  } catch (error) {
    return { error: error?.constructor?.name ?? 'Error' }
  }
})
process.stdout.write(JSON.stringify(results))
"""


def _run_plugin(calls: list[tuple[str, list[Any]]]) -> list[dict[str, Any]]:
    completed = subprocess.run(
        ["node", "--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", _NODE_DRIVER, str(DSH_PLUGIN_IDENTITY)],
        input=json.dumps(calls), capture_output=True, text=True, encoding="utf-8", check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"node failed: {completed.stderr}")
    return json.loads(completed.stdout)


def dsh_plugin_categories() -> dict[str, Any]:
    result: dict[str, Any] = {}
    namespaces = ["conn_1", "conn_1:dsh:rti_abc:" + "0" * 24, "连接器😀", "a:b", ""]
    externals = ["0195d5a6-4c1d-7000-8000-000000000000", "ext", "中文", "a:b", "", LONG_ASCII]

    calls: list[tuple[str, list[Any]]] = []
    labels: list[dict[str, Any]] = []
    for namespace in namespaces:
        for external in externals[:4]:
            calls.append(("sessionId", [namespace, external]))
            labels.append({"namespace": namespace, "externalSessionId": external})
    # AA-created DSH sessions: aa_{sha256(namespace)[:16]}_{platformId} maps back to the platform id.
    import hashlib

    for namespace in namespaces[:3]:
        prefix = "aa_" + hashlib.sha256(namespace.encode()).hexdigest()[:16] + "_"
        for platform_id in ("sess_dsh_abc", "a" * 128, "a" * 129, "has space", "中文", "x-y_z", ""):
            calls.append(("sessionId", [namespace, prefix + platform_id]))
            labels.append({"namespace": namespace, "externalSessionId": prefix + platform_id})
        calls.append(("sessionId", [namespace, "aa_" + "0" * 16 + "_sess"]))
        labels.append({"namespace": namespace, "externalSessionId": "aa_" + "0" * 16 + "_sess"})
    outputs = _run_plugin(calls)
    result["dshPlugin.sessionId"] = _category(
        "dsh-bridge-next/src/host/dsh-runtime/identity.ts:sessionId",
        "If externalSessionId = 'aa_' + sha256(namespace).hex[:16] + '_' + P with P matching /^[A-Za-z0-9_-]{1,128}$/, the platform id is P; "
        "otherwise 'sess_dsh_' + sha256(utf8(namespace + ':dsh:' + externalSessionId)).hex[:24] (= stable_runtime_session_id(namespace, 'dsh', ext) "
        "for non-empty inputs, but the plugin does not reject empty inputs). The namespace is the Connector's session_namespace sent as MeshCall metadata.",
        [_vector(label, output) for label, output in zip(labels, outputs, strict=True)],
    )

    calls, labels = [], []
    for namespace in namespaces:
        for platform_id in ("sess_dsh_abc", "a" * 128, "a" * 129, "has space", "中文", ""):
            calls.append(("nativeSessionId", [namespace, platform_id]))
            labels.append({"namespace": namespace, "platformSessionId": platform_id})
    outputs = _run_plugin(calls)
    result["dshPlugin.nativeSessionId"] = _category(
        "dsh-bridge-next/src/host/dsh-runtime/identity.ts:nativeSessionId",
        "'aa_' + sha256(namespace).hex[:16] + '_' + platformSessionId; platform id must match /^[A-Za-z0-9_-]{1,128}$/ else Error.",
        [_vector(label, output) for label, output in zip(labels, outputs, strict=True)],
    )

    calls, labels = [], []
    for external in ("ext-1", "中文", "a\u0000b", "", LONG_ASCII):
        for client in ("client-1", "continue:12", "中文😀", "a\u0000b", ""):
            calls.append(("userMessageId", [external, client]))
            labels.append({"externalSessionId": external, "clientMessageId": client})
    outputs = _run_plugin(calls)
    result["dshPlugin.userMessageId"] = _category(
        "dsh-bridge-next/src/host/dsh-runtime/identity.ts:userMessageId",
        "'aa.' + sha256(ext).hex[:16] + '.' + base64url_nopad(utf8(clientMessageId)). Continue messages use clientMessageId 'continue:{endSeq}'.",
        [_vector(label, output) for label, output in zip(labels, outputs, strict=True)],
    )

    calls, labels = [], []
    for external in ("ext-1", "中文", ""):
        for client in ("client-1", "中文😀", "continue:3"):
            encoded = _run_plugin([("userMessageId", [external, client])])[0]["output"]
            for native in (encoded, encoded + "x", encoded[:-1], "plain-native-id"):
                calls.append(("clientMessageId", [external, native]))
                labels.append({"externalSessionId": external, "nativeMessageId": native})
    outputs = _run_plugin(calls)
    result["dshPlugin.clientMessageId"] = _category(
        "dsh-bridge-next/src/host/dsh-runtime/identity.ts:clientMessageId",
        "Inverse of userMessageId: returns the client message id only if re-encoding reproduces nativeMessageId exactly, else null.",
        [_vector(label, output) for label, output in zip(labels, outputs, strict=True)],
    )

    calls, labels = [], []
    for external, kind, business in [
        ("ext-1", "tool", "call-1"), ("ext-1", "message", "seq:3"), ("sess_dsh_x", "turn-outcome", "40"), ("sess_dsh_x", "approval", "evt-1"),
        ("", "", ""), ("中文", "工具", "调用😀"), ("a\u0000b", "c", "d"), (LONG_ASCII, "tool", LONG_CJK),
        ("e", "turn", "7"), ("e", "question", "evt-2"), ("e", "reasoning", "k:0"), ("e", "message", "k:1"),
        ("e\u0301", "tool", "\u00e9"), ("\uffff", "\U00010000", "\U0010ffff"), ("x", "y", "z"), ("a:b", "c/d", "e\\f"),
        ("ext-2", "tool", "call-1"), ("ext-1", "tool", "call-2"), ("ext-1", "tool", ""), ("ext-1", "", "call-1"),
    ]:
        calls.append(("itemId", [external, kind, business]))
        labels.append({"externalSessionId": external, "kind": kind, "businessId": business})
    outputs = _run_plugin(calls)
    result["dshPlugin.itemId"] = _category(
        "dsh-bridge-next/src/host/dsh-runtime/identity.ts:itemId",
        "'dsh_' + sha256(utf8(ext + '\\0' + kind + '\\0' + businessId)).hex. Unlike the Python twin, empty components are accepted.",
        [_vector(label, output) for label, output in zip(labels, outputs, strict=True)],
    )
    return result


def dsh_end_to_end_category() -> dict[str, Any]:
    vectors = []
    calls: list[tuple[str, list[Any]]] = []
    pending: list[dict[str, Any]] = []
    for connector_id, runtime_id, home, external in [
        ("conn_1", "dsh", "/nonexistent-aa-vectors/home/.dsh", "0195d5a6-4c1d-7000-8000-000000000000"),
        ("conn_1", "rti_dsh1", "/nonexistent-aa-vectors/home/.dsh", "0195d5a6-4c1d-7000-8000-000000000000"),
        ("conn_1", "rti_dsh1", "/nonexistent-aa-vectors/Home/.DSH", "ext"),
        ("conn_1", "rti_dsh1", "/nonexistent-aa-vectors/Straße/.dsh", "ext"),
        ("conn_1", "rti_dsh2", "/nonexistent-aa-vectors/用户/.dsh", "中文"),
        ("连接器", "rti_dsh1", "/nonexistent-aa-vectors/😀", "ext"),
        ("conn:1", "rti_x", "/nonexistent-aa-vectors/a:b", "a:b"),
        ("conn_1", "rti_x", "/nonexistent-aa-vectors/ꮳ", "ext"),
        ("conn_1", "dsh", "/nonexistent-aa-vectors/other", "ext"),
        ("conn_1", "rti_x", "/", "ext"),
    ]:
        canonical = filesystem.canonical_path(home)
        for platform_name in ("darwin", "linux"):
            with mock.patch.object(filesystem.sys, "platform", platform_name):
                key = object.__new__(DshProvider).session_source_key(SimpleNamespace(values={"dshHome": canonical}))
            host = RuntimeInstanceHost(
                base=SimpleNamespace(connector_id=connector_id),
                instance=RuntimeInstanceSpec(runtime_id=runtime_id, runtime_type="dsh", name="DSH"),
                source_key=key,
            )
            namespace = host.session_namespace
            calls.append(("sessionId", [namespace, external]))
            pending.append({"input": {"connectorId": connector_id, "runtimeId": runtime_id, "dshHome": canonical,
                                      "platform": platform_name, "externalSessionId": external},
                            "namespace": namespace})
    for item, output in zip(pending, _run_plugin(calls), strict=True):
        vectors.append(_vector(item["input"], {"output": {"namespace": item["namespace"], "sessionId": output["output"]}}))
    return {"session.dshEndToEnd": _category(
        "Connector session_namespace (instance_binding.py) + DshProvider.session_source_key + plugin sessionId (identity.ts)",
        "Full DSH platform session id from Connector identity, instance, canonical dshHome and platform. Legacy instance 'dsh' ignores dshHome.",
        vectors,
    )}


# ---------------------------------------------------------------------------
# Unicode helpers the algorithms depend on
# ---------------------------------------------------------------------------


def unicode_categories() -> dict[str, Any]:
    result: dict[str, Any] = {}
    vectors = []
    for code in range(0x110000):
        if 0xD800 <= code <= 0xDFFF:
            continue
        char = chr(code)
        folded = char.casefold()
        if folded != char:
            vectors.append(_vector({"text": char}, {"output": folded}))
    for text in ("abc", "ı", "i", "ς", "Straße", "ẞ", "İ", "ﬁ", "ΐ", "Ꭰꭰ", "ᏸ", "中文", "😀", "ǅ", "\u0345", "K\u212a", "", "MiXeD/Path.JSON"):
        vectors.append(_vector({"text": text}, {"output": text.casefold()}))
    result["unicode.casefold"] = _category(
        "Python str.casefold (used by filesystem_resource_key on darwin)",
        "Every code point whose casefold differs from itself, plus sample strings. Code points not listed fold to themselves.",
        vectors,
    )

    vectors = []
    samples = [ord(c) for c in "aZ09_-.:/ \t中文ß²½Ⅻ①٣०𝟎ǅʰ々〇😀🎉\u0301\u200b\u00a0\u2028\uffff"]
    samples += list(range(0x80))
    samples += [0x10000, 0x1F600, 0x20000, 0x2A6DF, 0x10FFFF, 0xE000, 0xF900, 0x1D400, 0x16A0, 0x0E01]
    for code in samples:
        char = chr(code)
        vectors.append(_vector({"codePoint": code}, {"output": char.isalnum()}))
    result["unicode.isalnum"] = _category(
        "Python str.isalnum (used by codex _safe_component)",
        "Per code point. Under this Python's Unicode database isalnum() equals general category L* or N*.",
        vectors,
    )

    vectors = []
    for text in ("e\u0301", "\u212b", "A\u030a", "\u1e9b\u0323", "가", "\u1100\u1161", "ﬁ", "Ω", "\u2126", "abc", "", "中文", "😀",
                 "\u0041\u0308\u0301", "\u00c5", "o\u0328\u0304", "\u1e0b\u0323", "q\u0307\u0323", "\u0958", "\u2adc"):
        vectors.append(_vector({"text": text}, {"output": unicodedata.normalize("NFC", text)}))
    result["unicode.nfc"] = _category(
        "unicodedata.normalize('NFC') (used by filesystem_resource_key on darwin)",
        "NFC normalization samples.",
        vectors,
    )
    return result


def build() -> dict[str, Any]:
    categories: dict[str, Any] = {}
    for part in (
        session_categories(),
        dsh_end_to_end_category(),
        selection_categories(),
        codex_categories(),
        claude_categories(),
        acp_categories(),
        dsh_python_categories(),
        dsh_plugin_categories(),
        planning_categories(),
        unicode_categories(),
    ):
        overlap = categories.keys() & part.keys()
        assert not overlap, overlap
        categories.update(part)
    return {
        "contract": "identity-vectors",
        "version": "1.0",
        "generatedBy": "connector/scripts/export_identity_vectors.py",
        "generator": {
            "python": host_platform.python_version(),
            "unicodeData": unicodedata.unidata_version,
        },
        "categories": dict(sorted(categories.items())),
    }


def render(document: dict[str, Any]) -> str:
    """One vector per line; ASCII-only so lone surrogates and invisible characters stay unambiguous."""

    def dump(value: Any) -> str:
        return json.dumps(value, ensure_ascii=True, separators=(",", ":"))

    lines = ["{"]
    for key in ("contract", "version", "generatedBy", "generator"):
        lines.append(f" {dump(key)}:{dump(document[key])},")
    lines.append(' "categories":{')
    names = list(document["categories"])
    for position, name in enumerate(names):
        category = document["categories"][name]
        lines.append(f"  {dump(name)}:{{")
        for key, value in category.items():
            if key != "vectors":
                lines.append(f"   {dump(key)}:{dump(value)},")
        lines.append('   "vectors":[')
        vectors = category["vectors"]
        for index, vector in enumerate(vectors):
            lines.append("    " + dump(vector) + ("," if index < len(vectors) - 1 else ""))
        lines.append("   ]")
        lines.append("  }" + ("," if position < len(names) - 1 else ""))
    lines.append(" }")
    lines.append("}")
    text = "\n".join(lines) + "\n"
    assert json.loads(text) == document
    return text


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail when the committed vectors differ")
    args = parser.parse_args()
    text = render(build())
    if args.check:
        current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
        if current != text:
            print(f"{OUTPUT.relative_to(REPO)} is stale; rerun without --check", file=sys.stderr)
            return 1
        print("identity vectors up to date")
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(text, encoding="utf-8")
    document = json.loads(text)
    total = sum(len(category["vectors"]) for category in document["categories"].values())
    for name, category in document["categories"].items():
        print(f"{name}: {len(category['vectors'])}")
    print(f"wrote {total} vectors in {len(document['categories'])} categories to {OUTPUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
