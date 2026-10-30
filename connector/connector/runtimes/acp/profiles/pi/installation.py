"""Resolve a local CLI to its own SDK; never install into the user's package."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from ...domain.definitions import AcpError, fingerprint

PACKAGE = "@earendil-works/pi-coding-agent"
SUPPORTED_SDK = "1.4.0"


def agent_directory(values: dict) -> Path:
    return (
        Path(
            values.get("agentDir")
            or os.environ.get("PI_CODING_AGENT_DIR")
            or "~/.pi/agent"
        )
        .expanduser()
        .resolve()
    )


def history_directories(values: dict, agent_dir: Path) -> tuple[Path, ...]:
    paths = [agent_dir / "sessions"]
    try:
        setting = json.loads((agent_dir / "settings.json").read_text()).get(
            "sessionDir"
        )
        if isinstance(setting, str) and setting:
            paths.append(Path(setting).expanduser())
    except (OSError, ValueError, AttributeError):
        pass
    paths.extend(Path(value).expanduser() for value in values.get("historyDirs", []))
    return tuple(dict.fromkeys(path.resolve() for path in paths))


@dataclass(frozen=True)
class PiInstallation:
    cli: Path
    node: Path
    sdk: Path
    version: str


def _package_for(entry: Path) -> Path | None:
    for root in entry.resolve().parents:
        manifest = root / "package.json"
        try:
            if json.loads(manifest.read_text()).get("name") == PACKAGE:
                return root
        except (OSError, ValueError, AttributeError):
            continue
    return None


def resolve_local(values: dict) -> PiInstallation:
    specified = values.get("cliPath")
    command = str(Path(specified).expanduser()) if specified else shutil.which("pi")
    if not command and not specified:
        home = Path.home()
        candidates = [
            home / ".nvmd/bin/pi",
            home / ".local/bin/pi",
            home / ".npm-global/bin/pi",
            home / ".npm/bin/pi",
            Path("/opt/homebrew/bin/pi"),
            Path("/usr/local/bin/pi"),
        ]
        if os.name == "nt":
            candidates.extend(
                [
                    Path(os.environ.get("APPDATA", str(home / "AppData/Roaming")))
                    / "npm/pi.cmd"
                ]
            )
        found = [path for path in candidates if path.is_file()]
        if len(found) > 1:
            raise AcpError(
                "pi_installation_ambiguous",
                "发现多个本机 Pi 安装，请在 CLI 路径中选择："
                + "、".join(str(path) for path in found),
            )
        command = str(found[0]) if found else None
    if not command or not Path(command).is_file():
        raise AcpError(
            "pi_cli_missing", "未找到本机 pi，请指定 CLI 路径或明确选择受管环境。"
        )
    cli = Path(command).absolute()
    root = _package_for(cli)
    node_candidates = [cli.parent / ("node.exe" if os.name == "nt" else "node")]
    if found := shutil.which("node"):
        node_candidates.append(Path(found))
    node_candidates.extend(
        [
            Path.home() / ".nvmd/bin/node",
            Path.home() / ".local/bin/node",
            Path("/opt/homebrew/bin/node"),
            Path("/usr/local/bin/node"),
        ]
    )
    if root and len(root.parents) > 3:
        node_candidates.append(root.parents[3] / "bin/node")
    node = None
    for candidate in node_candidates:
        if not candidate.is_file():
            continue
        try:
            report = json.loads(
                subprocess.check_output(
                    [
                        str(candidate),
                        "--print",
                        "JSON.stringify({path:process.execPath,version:process.versions.node})",
                    ],
                    text=True,
                    timeout=10,
                    stderr=subprocess.DEVNULL,
                )
            )
            version = tuple(int(part) for part in report["version"].split("."))
            if version >= (22, 19, 0):
                node = Path(report["path"]).resolve()
                break
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            continue
    if node is None:
        raise AcpError(
            "pi_node_incompatible", "本机 Pi 需要可用的 Node 22.19 或更高版本。"
        )
    node_shim = cli.parent / ("node.exe" if os.name == "nt" else "node")
    if (
        root is None
        and not specified
        and node_shim.is_file()
        and node_shim.resolve() == cli.resolve()
    ):
        # Version-manager shims (e.g. nvmd) share the active Node's bin directory.
        # Only inspect that active installation, never choose an arbitrary version.
        for entry in (node.parent / "pi", node.parent / "pi.cmd"):
            if entry.is_file() and (root := _package_for(entry)):
                cli = entry
                break
    if root is None and cli.suffix.lower() in {".cmd", ".ps1"}:
        # npm's Windows launcher points into sibling node_modules, not a symlink.
        candidate = cli.parent / "node_modules" / PACKAGE
        if (candidate / "package.json").is_file():
            root = candidate
    if root is None:
        raise AcpError(
            "pi_installation_unsupported",
            "无法将此 pi 入口绑定到兼容 SDK；请指定 npm 安装的真实 pi 入口。",
        )
    manifest = json.loads((root / "package.json").read_text())
    if (
        manifest.get("version") != SUPPORTED_SDK
        or not (root / "dist/index.js").is_file()
    ):
        raise AcpError(
            "pi_sdk_incompatible",
            f"当前支持本机 Pi SDK {SUPPORTED_SDK}，此安装的 SDK 不兼容；不会使用其他 SDK 替代。",
        )
    return PiInstallation(cli.resolve(), node, root.resolve(), manifest["version"])


def tree_digest(root: Path) -> str:
    """Hash shipped runtime files, including native modules, excluding nested packages."""
    digest = hashlib.sha256()
    for current, directories, files in os.walk(root, followlinks=False):
        directories[:] = sorted(
            value for value in directories if value not in {"node_modules", ".git"}
        )
        for name in sorted(files):
            path = Path(current) / name
            digest.update(str(path.relative_to(root)).encode())
            with path.open("rb") as source:
                while block := source.read(1024 * 1024):
                    digest.update(block)
    return digest.hexdigest()


def installation_identity(installation: PiInstallation) -> dict:
    script = r"""
import {createRequire} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
const pending=[process.argv[1]], seen=new Map();
while(pending.length){
 const manifest=pending.pop(); if(seen.has(manifest))continue;
 const data=JSON.parse(readFileSync(manifest,'utf8')); seen.set(manifest,{path:manifest,name:data.name,version:data.version});
 const req=createRequire(manifest);
 for(const name of Object.keys({...data.dependencies,...data.optionalDependencies})){
  let found;try{found=req.resolve(name+'/package.json')}catch{
   try{let p=dirname(req.resolve(name));while(p!==dirname(p)){const f=join(p,'package.json');
    if(existsSync(f)&&JSON.parse(readFileSync(f,'utf8')).name===name){found=f;break}p=dirname(p)}}catch{}
  }
  if(found)pending.push(found);
 }
}
console.log(JSON.stringify([...seen.values()]));
"""
    try:
        packages = json.loads(
            subprocess.check_output(
                [
                    str(installation.node),
                    "--input-type=module",
                    "-e",
                    script,
                    str(installation.sdk / "package.json"),
                ],
                text=True,
                timeout=30,
                stderr=subprocess.DEVNULL,
            )
        )
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise AcpError(
            "pi_dependency_resolution_failed", "无法校验本机 Pi 的完整依赖来源。"
        ) from error
    for package in packages:
        package["sha256"] = tree_digest(Path(package["path"]).parent)
    value = {
        "cli": str(installation.cli),
        "node": str(installation.node),
        "nodeSha256": hashlib.sha256(installation.node.read_bytes()).hexdigest(),
        "sdk": str(installation.sdk),
        "version": installation.version,
        "packages": sorted(packages, key=lambda item: item["path"]),
    }
    return {**value, "digest": fingerprint(value)}
