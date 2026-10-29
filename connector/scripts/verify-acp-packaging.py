"""Check reproducible packaging and installation with ephemeral local keys."""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import tempfile
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from connector.runtimes.acp.infrastructure.artifacts import Artifacts


def main():
    with tempfile.TemporaryDirectory(prefix="aa-acp-package-") as directory:
        root = Path(directory)
        source = root / "source"
        source.mkdir()
        binary = source / "controlled-agent"
        binary.write_bytes(b"controlled artifact; never executed")
        binary.chmod(0o755)
        (source / "entry.js").write_text("// controlled prebuilt fixture\n")
        key = Ed25519PrivateKey.generate()
        private = root / "private.pem"
        private.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        private.chmod(0o600)
        metadata = root / "metadata.json"
        metadata.write_text(
            json.dumps(
                {
                    "schemaVersion": "1.0",
                    "profileId": "controlled",
                    "platform": sys.platform,
                    "architecture": {
                        "arm64": "arm64",
                        "aarch64": "arm64",
                        "x86_64": "x64",
                        "AMD64": "x64",
                    }[platform.machine()],
                    "launcher": {"executable": binary.name, "arguments": ["entry.js"]},
                    "provenance": {"source": "controlled-fixture"},
                    "protocols": [1],
                    "guarantees": [],
                }
            )
        )
        results = []
        for name in ("one", "two"):
            output = root / name
            subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).with_name("package-acp-component.py")),
                    "--source",
                    str(source),
                    "--metadata",
                    str(metadata),
                    "--signing-key",
                    str(private),
                    "--key-id",
                    "ephemeral",
                    "--output",
                    str(output),
                ],
                check=True,
                env={
                    **os.environ,
                    "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
                },
                capture_output=True,
            )
            envelope = json.loads(next(output.glob("*.json")).read_text())
            results.append((envelope, next(output.glob("*.zip"))))
        assert results[0][0] == results[1][0]
        assert results[0][1].read_bytes() == results[1][1].read_bytes()
        envelope, archive = results[0]
        artifact = Artifacts(
            root / "installed", {"ephemeral": key.public_key().public_bytes_raw()}
        )
        record = artifact.install(archive, envelope["manifest"], envelope["signature"])
        artifact.verify_installed(record)
        assert "private.pem" not in envelope["manifest"]["files"]
        print(
            "ACP packaging: byte-identical archives, stable signed release identity, excluded private key and verified installation passed (controlled artifact)"
        )


if __name__ == "__main__":
    main()
