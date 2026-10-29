"""Package a prebuilt Agent directory; never compile on deployment devices."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import zipfile
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from connector.runtimes.acp.domain.installations import (
    release_identity,
    validate_manifest,
)
from connector.runtimes.acp.infrastructure.artifacts import (
    canonical_manifest,
    relative_file,
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument(
        "--metadata",
        type=Path,
        required=True,
        help="Reviewed target, entry, provenance and guarantees",
    )
    parser.add_argument(
        "--signing-key",
        type=Path,
        required=True,
        help="Local Ed25519 PEM; never included in artifact",
    )
    parser.add_argument("--key-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.source.resolve(strict=True)
    output = args.output.resolve()
    if output.is_relative_to(root) or args.signing_key.resolve().is_relative_to(root):
        raise ValueError("输出和签名私钥必须位于组件源目录之外。")
    metadata = json.loads(args.metadata.read_text())
    if "files" in metadata:
        raise ValueError("文件清单必须由构建产物生成。")
    key = serialization.load_pem_private_key(
        args.signing_key.read_bytes(), password=None
    )
    if not isinstance(key, Ed25519PrivateKey):
        raise TypeError("需要 Ed25519 签名密钥。")
    files = {}
    for path in sorted(root.rglob("*")):
        if path.is_dir():
            continue
        if path.is_symlink() or not path.is_file():
            raise ValueError("组件源目录需要物化文件，不接受链接或特殊文件。")
        name = relative_file(path.relative_to(root).as_posix())
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        files[name] = {
            "sha256": digest,
            "size": path.stat().st_size,
            "executable": os.access(path, os.X_OK),
        }
    manifest = {**metadata, "files": files}
    validate_manifest(manifest)
    identifier = release_identity(manifest)
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"{identifier}.zip"
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = (
                0o100755 if files[name]["executable"] else 0o100644
            ) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            bundle.writestr(info, (root / name).read_bytes())
    with archive.open("rb") as stream:
        archive_digest = hashlib.file_digest(stream, "sha256").hexdigest()
    envelope = {
        "releaseId": identifier,
        "manifest": manifest,
        "signature": {
            "keyId": args.key_id,
            "signature": base64.b64encode(
                key.sign(canonical_manifest(manifest))
            ).decode(),
        },
        "archiveSha256": archive_digest,
    }
    (output / f"{identifier}.json").write_text(
        json.dumps(envelope, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    )
    print(
        f"ACP component {identifier}: {manifest['platform']}/{manifest['architecture']}, entry={manifest['launcher']['executable']}"
    )


if __name__ == "__main__":
    main()
