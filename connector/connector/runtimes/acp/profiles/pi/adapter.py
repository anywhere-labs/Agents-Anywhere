"""Small, anchor-verified compatibility patch of the third-party release."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

from ...domain.definitions import AcpError, fingerprint
from ...infrastructure.npm import installation_lock

PATCH_REVISION = 6
# Every 0.1.x release so far keeps the patched entry points unchanged; each
# anchor below is still required to match before the adapter is used.
SUPPORTED_ADAPTER = (0, 1)
ANCHORS = (
    (
        "async function findSession(sessionId, sessionDir) {",
        "async function findSession(sessionId, sessionDir) {\n  if(process.env.AA_PI_SESSION_FILE) return aaFindSession(sessionId);",
    ),
    (
        "await session.prompt(converted.text, converted.images)",
        "await aaWithMessage(params, () => session.prompt(converted.text, converted.images))",
    ),
    (
        "await session.steer(converted.text, converted.images)",
        "await aaWithMessage(params, () => session.steer(converted.text, converted.images))",
    ),
    (
        "return buildConfigOptions(this.session, {\n      booleanOptions: this.features.booleanConfigOptions\n    });",
        "return aaConfigOptions(this.session, buildConfigOptions(this.session, {\n      booleanOptions: this.features.booleanConfigOptions\n    }));",
    ),
    (
        "extensions: session.extensions(),",
        "extensions: session.extensions(), aaLoadingReport: aaLoadingReport(),",
    ),
)
REQUIRE_MODEL = re.compile(
    r"await this\.requireModel\(session\)\.catch\(\(error\) => \{\n.*?\n    \}\);"
)


def adapter_version(package: Path) -> str:
    version = json.loads((package / "package.json").read_text(encoding="utf-8")).get(
        "version"
    )
    try:
        parts = tuple(int(part) for part in str(version).split("-")[0].split("."))
    except ValueError:
        parts = ()
    if parts[:2] != SUPPORTED_ADAPTER:
        raise AcpError(
            "pi_adapter_incompatible",
            f"Pi ACP 适配器 {version} 不受支持，需要 0.1.x。",
        )
    return version


def _patch(sources: dict[str, str]) -> dict[str, str]:
    patched = {
        name: source.replace('"@earendil-works/pi-coding-agent"', '"../sdk-bridge.mjs"')
        for name, source in sources.items()
    }
    touched = set()
    for old, new in ANCHORS:
        owners = [name for name, source in patched.items() if old in source]
        if not owners:
            raise AcpError(
                "pi_adapter_patch_failed", "Pi ACP 兼容入口已变化，已停止准备。"
            )
        for name in owners:
            patched[name] = patched[name].replace(old, new)
        touched.update(owners)
    matches = 0
    for name in list(patched):
        patched[name], count = REQUIRE_MODEL.subn(
            "await this.requireModel(session);", patched[name]
        )
        matches += count
        touched.update([name] if count else [])
    if matches != 3:
        raise AcpError("pi_adapter_patch_failed", "Pi ACP 模型就绪校验入口已变化。")
    for name in touched:
        patched[name] = (
            'import {aaFindSession, aaWithMessage, aaConfigOptions, aaLoadingReport} from "../sdk-bridge.mjs";\n'
            + patched[name].replace(
                "if (pi.model === void 0 && available.length > 0) {",
                "if (pi.model === void 0 && available.length > 0 && !process.env.AA_PI_SESSION_FILE) {",
            )
        )
    return patched


def prepare_adapter(entry: Path, sdk: Path, root: Path) -> tuple[Path, dict]:
    package = entry.parent.parent
    version = adapter_version(package)
    sources = {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted(entry.parent.glob("*.js"))
    }
    if entry.name not in sources:
        raise AcpError("pi_adapter_incompatible", "Pi ACP 适配器入口不存在。")
    release_files = {
        name: hashlib.sha256(source.encode("utf-8")).hexdigest()
        for name, source in sources.items()
    }
    patched_sources = _patch(sources)
    bridge = (
        Path(__file__)
        .with_name("sdk-bridge.mjs")
        .read_text(encoding="utf-8")
        .replace("__AA_PI_SDK_URL__", (sdk / "dist/index.js").as_uri())
    )
    patch = fingerprint(
        {"bridge": bridge, "source": release_files, "revision": PATCH_REVISION}
    )
    destination = root / patch
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with installation_lock(root / ".patch.lock"):  # noqa: SIM117 -- staging is scoped inside the installation lease
        # Regenerate from verified inputs; do not trust stale executable cache files.
        with tempfile.TemporaryDirectory(prefix=".adapter-", dir=root) as temporary:
            staging = Path(temporary) / "adapter"
            shutil.copytree(
                package, staging, ignore=shutil.ignore_patterns("node_modules")
            )
            (staging / "sdk-bridge.mjs").write_text(
                bridge, encoding="utf-8", newline="\n"
            )
            for name, source in patched_sources.items():
                (staging / "dist" / name).write_text(
                    source, encoding="utf-8", newline="\n"
                )
            # Keep third-party dependency resolution attached to its original install.
            modules = next(
                (
                    parent / "node_modules"
                    for parent in (package, *package.parents)
                    if (parent / "node_modules").is_dir()
                ),
                None,
            )
            if modules is None:
                raise AcpError(
                    "pi_adapter_dependencies_missing", "Pi ACP 依赖目录不存在。"
                )
            try:
                (staging / "node_modules").symlink_to(modules, target_is_directory=True)
            except OSError:
                if os.name != "nt":
                    raise
                import _winapi

                _winapi.CreateJunction(str(modules), str(staging / "node_modules"))
            if destination.exists():
                for path in [
                    staging / "sdk-bridge.mjs",
                    *(staging / "dist" / name for name in release_files),
                ]:
                    cached = destination / path.relative_to(staging)
                    if not cached.is_file() or cached.read_bytes() != path.read_bytes():
                        raise AcpError(
                            "pi_adapter_cache_corrupt",
                            "Pi ACP 可执行缓存校验失败，请停止相关实例后清理缓存重试。",
                        )
                if (destination / "node_modules").resolve() != modules.resolve():
                    raise AcpError(
                        "pi_adapter_cache_corrupt", "Pi ACP 缓存依赖来源已变化。"
                    )
            else:
                staging.rename(destination)
    metadata = {
        "package": "@openma/pi-acp",
        "version": version,
        "sourceFiles": release_files,
        "patchDigest": patch,
        "sdkEntry": str(sdk / "dist/index.js"),
    }
    return destination / "dist" / entry.name, metadata

