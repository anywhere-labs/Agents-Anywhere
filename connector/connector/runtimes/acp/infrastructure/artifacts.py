from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import shutil
import stat
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from ..domain.definitions import AcpError
from ..domain.installations import release_identity, validate_manifest


def canonical_manifest(manifest: dict) -> bytes:
    return json.dumps(
        manifest,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()


def relative_file(name: str) -> str:
    path = PurePosixPath(name)
    if (
        not name
        or "\\" in name
        or ":" in name
        or path.is_absolute()
        or any(part in {"", ".", ".."} for part in name.split("/"))
        or str(path) != name
    ):
        raise AcpError("invalid_component_path", "组件包含不安全的文件路径。")
    if any(
        part.split(".")[0].upper()
        in {
            "CON",
            "PRN",
            "AUX",
            "NUL",
            *(f"COM{i}" for i in range(1, 10)),
            *(f"LPT{i}" for i in range(1, 10)),
        }
        or part.endswith((".", " "))
        for part in path.parts
    ):
        raise AcpError("invalid_component_path", "组件文件名不符合跨平台要求。")
    return name


class Artifacts:
    def __init__(self, root: Path, trusted_keys: dict[str, bytes]):
        self.root, self.trusted_keys = root.resolve(), dict(trusted_keys)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)

    def verify_signature(self, manifest: dict, signature: dict):
        key = self.trusted_keys.get(signature.get("keyId"))
        if key is None:
            raise AcpError("component_untrusted", "组件签名不属于受信发布者。")
        try:
            Ed25519PublicKey.from_public_bytes(key).verify(
                base64.b64decode(signature["signature"], validate=True),
                canonical_manifest(manifest),
            )
        except Exception as error:
            raise AcpError(
                "component_signature_invalid", "组件签名校验失败。"
            ) from error

    def install(self, archive: Path, manifest: dict, signature: dict) -> dict:
        self.verify_signature(manifest, signature)
        validate_manifest(manifest)
        architecture = {
            "aarch64": "arm64",
            "arm64": "arm64",
            "x86_64": "x64",
            "AMD64": "x64",
        }.get(platform.machine())
        if (
            manifest["platform"] != sys.platform
            or manifest["architecture"] != architecture
        ):
            raise AcpError("component_platform_mismatch", "组件不适用于该工作设备。")
        paths = [relative_file(name) for name in manifest["files"]]
        if manifest["platform"] == "win32" and len(
            {name.casefold() for name in paths}
        ) != len(paths):
            raise AcpError("component_path_collision", "组件路径存在大小写冲突。")
        release_id = release_identity(manifest)
        destination = self.root / release_id
        record = {
            "releaseId": release_id,
            "profileId": manifest["profileId"],
            "status": "ready",
            "path": str(destination),
            "manifest": manifest,
            "signature": signature,
        }
        if destination.exists():
            self.verify_installed(record)
            return record
        staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=self.root))
        try:
            with zipfile.ZipFile(archive) as bundle:
                files = [item for item in bundle.infolist() if not item.is_dir()]
                if len(files) != len(paths) or {item.filename for item in files} != set(
                    paths
                ):
                    raise AcpError(
                        "component_inventory_mismatch", "组件文件与签名清单不一致。"
                    )
                for item in files:
                    relative_file(item.filename)
                    mode = item.external_attr >> 16
                    if stat.S_ISLNK(mode) or (
                        stat.S_IFMT(mode) not in {0, stat.S_IFREG}
                    ):
                        raise AcpError(
                            "component_link_forbidden", "组件不能包含链接或特殊文件。"
                        )
                    expected = manifest["files"][item.filename]
                    if item.file_size != expected["size"]:
                        raise AcpError(
                            "component_size_mismatch", "组件文件大小不一致。"
                        )
                    target = staging / item.filename
                    target.parent.mkdir(parents=True, exist_ok=True)
                    digest = hashlib.sha256()
                    size = 0
                    with bundle.open(item) as source, target.open("xb") as output:
                        while block := source.read(65536):
                            size += len(block)
                            if size > expected["size"]:
                                raise AcpError(
                                    "component_too_large", "组件展开超过清单大小。"
                                )
                            digest.update(block)
                            output.write(block)
                        output.flush()
                        os.fsync(output.fileno())
                    if (
                        digest.hexdigest() != expected["sha256"]
                        or size != expected["size"]
                    ):
                        raise AcpError(
                            "component_checksum_invalid", "组件完整性校验失败。"
                        )
                    if expected.get("executable") is True:
                        target.chmod(0o755)
            os.rename(staging, destination)
            return record
        finally:
            if staging.exists():
                shutil.rmtree(staging)

    def verify_installed(self, record: dict):
        manifest = record["manifest"]
        self.verify_signature(manifest, record["signature"])
        validate_manifest(manifest)
        root = self.root / release_identity(manifest)
        if record["releaseId"] != root.name or Path(record["path"]) != root:
            raise AcpError("component_identity_conflict", "组件安装位置与身份不符。")
        for name, expected in manifest["files"].items():
            path = root / relative_file(name)
            if (
                path.is_symlink()
                or not path.resolve().is_relative_to(root)
                or not path.is_file()
                or path.stat().st_size != expected["size"]
            ):
                raise AcpError("component_modified", "已安装组件文件已变化。")
            with path.open("rb") as source:
                if (
                    hashlib.file_digest(source, "sha256").hexdigest()
                    != expected["sha256"]
                ):
                    raise AcpError("component_modified", "已安装组件校验失败。")

    def remove(self, record: dict):
        self.verify_installed(record)
        shutil.rmtree(self.root / record["releaseId"])
