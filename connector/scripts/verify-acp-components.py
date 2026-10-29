"""Direct signature/install/activation checks using ephemeral signing keys."""

from __future__ import annotations

import base64
import hashlib
import platform
import sys
import tempfile
import zipfile
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from connector.runtimes.acp.application.installations import InstallationService
from connector.runtimes.acp.domain.definitions import AcpError
from connector.runtimes.acp.infrastructure.artifacts import (
    Artifacts,
    canonical_manifest,
)
from connector.runtimes.acp.infrastructure.persistence import Store


def main():
    with tempfile.TemporaryDirectory(prefix="aa-acp-components-") as directory:
        root = Path(directory)
        key = Ed25519PrivateKey.generate()
        artifacts = Artifacts(
            root / "releases", {"controlled": key.public_key().public_bytes_raw()}
        )
        store = Store(root / "state.sqlite")
        service = InstallationService(store, artifacts)

        def component(label):
            files = {"bin/node": b"controlled-executable", "agent.js": label.encode()}
            manifest = {
                "schemaVersion": "1.0",
                "profileId": "pi",
                "platform": sys.platform,
                "architecture": {
                    "arm64": "arm64",
                    "aarch64": "arm64",
                    "x86_64": "x64",
                    "AMD64": "x64",
                }[platform.machine()],
                "launcher": {"executable": "bin/node", "arguments": ["agent.js"]},
                "files": {
                    name: {
                        "sha256": hashlib.sha256(data).hexdigest(),
                        "size": len(data),
                        "executable": name == "bin/node",
                    }
                    for name, data in files.items()
                },
                "protocols": [1],
                "guarantees": [],
                "provenance": {"source": "controlled-fixture"},
            }
            signature = {
                "keyId": "controlled",
                "signature": base64.b64encode(
                    key.sign(canonical_manifest(manifest))
                ).decode(),
            }
            archive = root / f"{label}.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                for name, data in files.items():
                    bundle.writestr(name, data)
            return archive, manifest, signature

        try:
            first = component("first")
            installed = service.install(*first)
            assert service.install(*first) == installed
            service.activate("pi", installed["releaseId"])
            store.put("binding", "session", {"release_id": installed["releaseId"]})
            second = service.install(*component("second"))
            service.activate("pi", second["releaseId"])
            assert (
                store.require("binding", "session")["release_id"]
                == installed["releaseId"]
            )
            try:
                service.remove(installed["releaseId"])
                raise AssertionError("deleted a referenced component")
            except AcpError as error:
                assert error.code == "component_in_use"
            assert service.rollback("pi")["releaseId"] == installed["releaseId"]
            unselected = service.install(*component("unselected"))
            store.put(
                "executor_reference",
                "preparing",
                {"releaseId": unselected["releaseId"]},
            )
            try:
                service.remove(unselected["releaseId"])
                raise AssertionError("deleted component held by preparing executor")
            except AcpError as error:
                assert error.code == "component_in_use"
            store.delete("executor_reference", "preparing")
            store.put(
                "component_operation",
                "unknown-update",
                {
                    "releaseId": unselected["releaseId"],
                    "phase": "outcome_unknown",
                    "action": "activate",
                },
            )
            try:
                service.remove(unselected["releaseId"])
                raise AssertionError("deleted component held by unknown operation")
            except AcpError as error:
                assert error.code == "component_in_use"
            store.delete("component_operation", "unknown-update")
            service.remove(unselected["releaseId"])
            assert store.get("installation", unselected["releaseId"]) is None
            try:
                artifacts.install(
                    first[0],
                    first[1],
                    {
                        "keyId": "controlled",
                        "signature": base64.b64encode(b"x" * 64).decode(),
                    },
                )
                raise AssertionError("invalid signature accepted")
            except AcpError as error:
                assert error.code == "component_signature_invalid"
            (Path(installed["path"]) / "agent.js").write_text("tampered")
            try:
                service.activate("pi", installed["releaseId"])
                raise AssertionError("modified installed component activated")
            except AcpError as error:
                assert error.code == "component_modified"
            assert (
                store.require("active_component", "pi")["releaseId"]
                == installed["releaseId"]
            )
            try:
                with store.transaction():
                    store.put("probe", "rollback", {"value": True})
                    store.emit("controlled", {})
                    raise RuntimeError("controlled transaction failure")
            except RuntimeError:
                pass
            assert store.get("probe", "rollback") is None and not store.pending()
            print(
                "ACP signed components: immutable install, tamper rejection, activation, session pinning, rollback, referenced removal and atomic outbox: passed"
            )
        finally:
            store.close()


if __name__ == "__main__":
    main()
