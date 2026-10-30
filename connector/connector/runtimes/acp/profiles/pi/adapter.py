"""Small, integrity-bound compatibility patch of the third-party release."""

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

RELEASE_FILES = {
    "bin.js": "066e83d7f9b4ccbd475691af05a5be365aec0927574769dcacd21e22abe49382",
    "index.js": "7a176beaea6265d0f72e383794cdd9def31a76fd540445b8bbf4301194e7a6b8",
    "chunk-5IXHVFXW.js": "f4c2b485e9a9cac894149366c362b6c7625aaeaa5fe04e5fb9c6b761afee4f79",
}


def prepare_adapter(entry: Path, sdk: Path, root: Path) -> tuple[Path, dict]:
    package = entry.parent.parent
    if json.loads((package / "package.json").read_text()).get("version") != "0.1.8":
        raise AcpError("pi_adapter_incompatible", "Pi ACP 适配器版本不匹配。")
    for name, expected in RELEASE_FILES.items():
        if hashlib.sha256((entry.parent / name).read_bytes()).hexdigest() != expected:
            raise AcpError(
                "pi_adapter_integrity_failed",
                "Pi ACP 发布包摘要不匹配，未应用兼容补丁。",
            )
    bridge = (
        Path(__file__)
        .with_name("sdk-bridge.mjs")
        .read_text()
        .replace("__AA_PI_SDK_URL__", (sdk / "dist/index.js").as_uri())
    )
    patch = fingerprint({"bridge": bridge, "source": RELEASE_FILES, "revision": 3})
    destination = root / patch
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with installation_lock(root / ".patch.lock"):  # noqa: SIM117 -- staging is scoped inside the installation lease
        # Regenerate from verified inputs; do not trust stale executable cache files.
        with tempfile.TemporaryDirectory(prefix=".adapter-", dir=root) as temporary:
            staging = Path(temporary) / "adapter"
            shutil.copytree(
                package, staging, ignore=shutil.ignore_patterns("node_modules")
            )
            (staging / "sdk-bridge.mjs").write_text(bridge)
            for name in RELEASE_FILES:
                path = staging / "dist" / name
                source = path.read_text().replace(
                    '"@earendil-works/pi-coding-agent"', '"../sdk-bridge.mjs"'
                )
                if name.startswith("chunk-"):
                    source = (
                        'import {aaFindSession, aaBeforePrompt, aaLoadingReport} from "../sdk-bridge.mjs";\n'
                        + source
                    )
                    for old, new in (
                        (
                            "async function findSession(sessionId, sessionDir) {",
                            "async function findSession(sessionId, sessionDir) {\n  if(process.env.AA_PI_SESSION_FILE) return aaFindSession(sessionId);",
                        ),
                        (
                            "  async prompt(params) {",
                            "  async prompt(params) {\n    aaBeforePrompt(params);",
                        ),
                        (
                            "extensions: session.extensions(),",
                            "extensions: session.extensions(), aaLoadingReport: aaLoadingReport(),",
                        ),
                    ):
                        if old not in source:
                            raise AcpError(
                                "pi_adapter_patch_failed",
                                "Pi ACP 兼容入口已变化，已停止准备。",
                            )
                        source = source.replace(old, new)
                    source, matches = re.subn(
                        r"await this\.requireModel\(session\)\.catch\(\(error\) => \{\n.*?\n    \}\);",
                        "await this.requireModel(session);",
                        source,
                    )
                    if matches != 3:
                        raise AcpError(
                            "pi_adapter_patch_failed", "Pi ACP 模型就绪校验入口已变化。"
                        )
                    source = source.replace(
                        "if (pi.model === void 0 && available.length > 0) {",
                        "if (pi.model === void 0 && available.length > 0 && !process.env.AA_PI_SESSION_FILE) {",
                    )
                path.write_text(source)
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
                    *(staging / "dist" / name for name in RELEASE_FILES),
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
        "version": "0.1.8",
        "sourceFiles": RELEASE_FILES,
        "patchDigest": patch,
        "sdkEntry": str(sdk / "dist/index.js"),
    }
    return destination / "dist/bin.js", metadata
