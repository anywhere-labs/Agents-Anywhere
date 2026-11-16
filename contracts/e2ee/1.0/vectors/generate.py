#!/usr/bin/env python3
"""Generate the E2EE 1.0 Noise test vectors shared by TS, Kotlin and Swift.

Two files are produced next to this script:

* ``noise-official.json``: the ``Noise_*_25519_AESGCM_SHA256`` vectors (fundamental
  patterns and psk modifiers) copied verbatim from the cacophony and snow test
  suites at pinned commits. They prove each implementation follows the Noise spec.
* ``aa-formats.json``: AA byte formats outside Noise (client ids, fingerprints, prologues,
  sealed display envelopes, sealed attachment/share segments, input digests, framing, pairing URI).
* ``aa-noise.json``: AA's own vectors for the two handshakes AA uses
  (``XXpsk0`` pairing and ``KK`` reconnect) with AA prologues, transport frames in
  both directions, rekey, and negative cases. They are produced by an independent
  implementation (the ``noiseprotocol`` package, backed by ``cryptography``), not by
  any of the three AA implementations under test.

Usage (from the repository root)::

    uv run --no-project --with noiseprotocol==0.3.1 python contracts/e2ee/1.0/vectors/generate.py
    uv run --no-project --with noiseprotocol==0.3.1 python contracts/e2ee/1.0/vectors/generate.py --check
    uv run --no-project --with noiseprotocol==0.3.1 python contracts/e2ee/1.0/vectors/generate.py --refresh-official
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import re
import sys
import urllib.request
import warnings
from pathlib import Path

from noise.connection import Keypair, NoiseConnection

# Fixed ephemeral keys are the point of test vectors.
warnings.filterwarnings("ignore", message="One of ephemeral keypairs is already set")

HERE = Path(__file__).resolve().parent
SUITE = "25519_AESGCM_SHA256"
OFFICIAL_SOURCES = [
    {
        "name": "cacophony",
        "license": "Unlicense",
        "url": "https://raw.githubusercontent.com/haskell-cryptography/cacophony/"
        "18b7348c54fd61fcd0c220298883de0d09c8364d/vectors/cacophony.txt",
    },
    {
        "name": "snow",
        "license": "Apache-2.0",
        "url": "https://raw.githubusercontent.com/mcginty/snow/"
        "d00b360cc61a7fe519ce7539974dca4f36c4654a/tests/vectors/snow.txt",
    },
]
FUNDAMENTAL = re.compile(r"^Noise_([NKX]|NN|NK|NX|XN|XK|XX|KN|KK|KX|IN|IK|IX)(psk\d(\+psk\d)*)?_" + SUITE + "$")


def key(label: str) -> bytes:
    """Deterministic 32-byte secret for a vector role. Test-only; never used outside vectors."""
    return hashlib.sha256(f"aa-e2ee/1.0 test vector {label}".encode()).digest()


def x25519_public(private: bytes) -> bytes:
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    return X25519PrivateKey.from_private_bytes(private).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)


def prologue(*fields: str) -> bytes:
    """AA prologue: ``aa-e2ee/1.0`` and the binding fields, NUL separated."""
    return "\0".join(("aa-e2ee/1.0", *fields)).encode()


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def client_id_for(identity_pub: bytes) -> str:
    digest = hashlib.sha256(prologue("client-id") + b"\0" + identity_pub).digest()
    return "cli_" + base64.b32encode(digest).decode().lower()[:26]


def fingerprint(identity_pub: bytes) -> str:
    digest = hashlib.sha256(identity_pub).hexdigest()[:32]
    return " ".join(digest[i:i + 4] for i in range(0, 32, 4))


def connection(protocol: str, *, initiator: bool, prologue_bytes: bytes, static: bytes | None,
               ephemeral: bytes, remote_static: bytes | None, psks: list[bytes]) -> NoiseConnection:
    conn = NoiseConnection.from_name(protocol.encode())
    if initiator:
        conn.set_as_initiator()
    else:
        conn.set_as_responder()
    conn.set_prologue(prologue_bytes)
    if static is not None:
        conn.set_keypair_from_private_bytes(Keypair.STATIC, static)
    conn.set_keypair_from_private_bytes(Keypair.EPHEMERAL, ephemeral)
    if remote_static is not None:
        conn.set_keypair_from_public_bytes(Keypair.REMOTE_STATIC, remote_static)
    if psks:
        conn.set_psks(psks=psks)
    conn.start_handshake()
    return conn


def build_vector(name: str, description: str, protocol: str, *, handshake_messages: int,
                 init: dict, resp: dict, payloads: list[tuple[str, bytes]],
                 rekey_before: frozenset[int] = frozenset()) -> dict:
    """Run a full exchange and record every byte; ``payloads`` lists (sender, payload)."""
    initiator = connection(protocol, initiator=True, **init)
    responder = connection(protocol, initiator=False, **resp)
    parties = {"initiator": initiator, "responder": responder}
    messages = []
    for index, (sender, payload) in enumerate(payloads):
        tx = parties[sender]
        rx = parties["responder" if sender == "initiator" else "initiator"]
        entry: dict = {"sender": sender, "payload": payload.hex()}
        if index < handshake_messages:
            ciphertext = tx.write_message(payload)
            received = rx.read_message(ciphertext)
        else:
            if index in rekey_before:
                tx.rekey_outbound_cipher()
                rx.rekey_inbound_cipher()
                entry["rekey_before"] = True
            ciphertext = tx.encrypt(payload)
            received = rx.decrypt(ciphertext)
        assert bytes(received) == payload, (name, index)
        entry["ciphertext"] = bytes(ciphertext).hex()
        messages.append(entry)
        if index == handshake_messages - 1:
            assert initiator.handshake_finished and responder.handshake_finished
            assert initiator.get_handshake_hash() == responder.get_handshake_hash()
            handshake_hash = bytes(initiator.get_handshake_hash()).hex()

    def role(prefix: str, spec: dict) -> dict:
        out = {f"{prefix}_prologue": spec["prologue_bytes"].hex(), f"{prefix}_ephemeral": spec["ephemeral"].hex()}
        if spec["static"] is not None:
            out[f"{prefix}_static"] = spec["static"].hex()
        if spec["remote_static"] is not None:
            out[f"{prefix}_remote_static"] = spec["remote_static"].hex()
        if spec["psks"]:
            out[f"{prefix}_psks"] = [psk.hex() for psk in spec["psks"]]
        return out

    return {
        "name": name,
        "description": description,
        "protocol_name": protocol,
        "handshake_messages": handshake_messages,
        **role("init", init),
        **role("resp", resp),
        "handshake_hash": handshake_hash,
        "messages": messages,
    }


def aa_vectors() -> dict:
    device_s, client_s = key("device static"), key("client static")
    device_pub, client_pub = x25519_public(device_s), x25519_public(client_s)
    psk = key("pairing psk")
    device_id, pairing_id, ch = "dev_vector", "pair_vector", "c_1"
    client_id = client_id_for(client_pub)
    pair_prologue = prologue("pair", device_id, pairing_id, client_id, ch)
    connect_prologue = prologue("connect", device_id, client_id, ch)

    # Pairing: the client (initiator) scanned the QR code, so it knows the psk and the
    # device key, but XX still transmits both static keys; the client compares the
    # device key it received with the one from the QR code after message 2.
    pairing_init = {"prologue_bytes": pair_prologue, "static": client_s, "ephemeral": key("pair client e"),
                    "remote_static": None, "psks": [psk]}
    pairing_resp = {"prologue_bytes": pair_prologue, "static": device_s, "ephemeral": key("pair device e"),
                    "remote_static": None, "psks": [psk]}
    large = bytes((i * 7) & 0xFF for i in range(2000))
    pairing_payloads = [
        ("initiator", b'{"label":"Pixel 9","platform":"android"}'),
        ("responder", b'{"deviceId":"dev_vector"}'),
        ("initiator", b""),
        ("responder", b'\x01{"kind":"pair.committed"}'),
        ("initiator", b"\x01{}"),
        ("initiator", large),
        ("responder", b""),
    ]

    connect_init = {"prologue_bytes": connect_prologue, "static": client_s, "ephemeral": key("kk client e"),
                    "remote_static": device_pub, "psks": []}
    connect_resp = {"prologue_bytes": connect_prologue, "static": device_s, "ephemeral": key("kk device e"),
                    "remote_static": client_pub, "psks": []}
    connect_payloads = [
        ("initiator", b""),
        ("responder", b""),
        ("initiator", b'\x01{"kind":"request","id":"r1","method":"GET","path":"/api/v2/sessions"}'),
        ("responder", b'\x01{"kind":"response","id":"r1","status":200,"body":{"items":[]}}'),
        ("initiator", b"\x02"),
        ("initiator", b"\x01after rekey"),
        ("responder", b"\x02"),
        ("responder", b"\x01after rekey"),
        ("responder", b"\x01second frame after rekey"),
    ]

    vectors = [
        build_vector("pairing", "First pairing over Noise_XXpsk0 with the AA pair prologue; transport frames "
                     "after Split include a 2000-byte one.", "Noise_XXpsk0_25519_AESGCM_SHA256",
                     handshake_messages=3, init=pairing_init, resp=pairing_resp, payloads=pairing_payloads),
        build_vector("reconnect", "Reconnect over Noise_KK with pinned keys; each side rekeys its send "
                     "direction once (rekey_before).", "Noise_KK_25519_AESGCM_SHA256",
                     handshake_messages=2, init=connect_init, resp=connect_resp, payloads=connect_payloads,
                     rekey_before=frozenset({5, 7})),
    ]

    # Negative cases: the reader of `fail_at` must reject the message (MAC failure).
    wrong_psk = key("server guessed psk")
    negative = [
        {
            "name": "pairing-wrong-psk",
            "description": "A relay that does not know the QR psk cannot complete pairing: "
            "the device rejects message 1.",
            "base": "pairing", "override": {"resp_psks": [wrong_psk.hex()]}, "fail_at": 0,
        },
        {
            "name": "pairing-tampered-device-key",
            "description": "Flipping a byte of the encrypted device static key in message 2 makes "
            "the client reject it.",
            "base": "pairing", "tamper": {"message": 1, "byte": 40}, "fail_at": 1,
        },
        {
            "name": "reconnect-unknown-client",
            "description": "The device has a different key pinned for this client: KK fails at message 1.",
            "base": "reconnect", "override": {"resp_remote_static": x25519_public(key("other client")).hex()},
            "fail_at": 0,
        },
        {
            "name": "reconnect-prologue-mismatch",
            "description": "The relay rewrote the route (client id) so prologues differ: KK fails at message 1.",
            "base": "reconnect",
            "override": {"resp_prologue": prologue("connect", device_id, client_id_for(x25519_public(key("other client"))), ch).hex()},
            "fail_at": 0,
        },
        {
            "name": "reconnect-replayed-frame",
            "description": "Delivering transport message 2 a second time to the device fails "
            "(the receive counter has moved on).",
            "base": "reconnect", "replay": {"message": 2}, "fail_at": 2,
        },
    ]
    return {
        "version": "1.0",
        "suite": SUITE,
        "generator": "contracts/e2ee/1.0/vectors/generate.py (noiseprotocol 0.3.1 + cryptography)",
        "conventions": {
            "keys": "init_* is the client, resp_* is the device. Static/ephemeral values are X25519 private keys.",
            "messages": "The first handshake_messages entries are handshake messages; the rest are transport "
            "messages encrypted with the sender's send CipherState. rekey_before: the sender rekeys its send "
            "CipherState and the receiver its receive CipherState before this message.",
            "prologue": "UTF-8 of 'aa-e2ee/1.0', then NUL-separated binding fields: "
            "pair: 'pair', deviceId, pairingId, clientId, ch; connect: 'connect', deviceId, clientId, ch.",
        },
        "vectors": vectors,
        "negative": [verify_negative(case, {v["name"]: v for v in vectors}) for case in negative],
    }


def verify_negative(case: dict, bases: dict) -> dict:
    """Run a negative case with the independent implementation and make sure it fails where stated."""
    base = {**bases[case["base"]], **case.get("override", {})}
    messages = [dict(m) for m in base["messages"]]
    if "tamper" in case:
        target = messages[case["tamper"]["message"]]
        raw = bytearray.fromhex(target["ciphertext"])
        raw[case["tamper"]["byte"]] ^= 0x01
        target["ciphertext"] = raw.hex()

    def side(prefix: str, initiator: bool) -> NoiseConnection:
        return connection(
            base["protocol_name"], initiator=initiator,
            prologue_bytes=bytes.fromhex(base[f"{prefix}_prologue"]),
            static=bytes.fromhex(base[f"{prefix}_static"]) if f"{prefix}_static" in base else None,
            ephemeral=bytes.fromhex(base[f"{prefix}_ephemeral"]),
            remote_static=bytes.fromhex(base[f"{prefix}_remote_static"]) if f"{prefix}_remote_static" in base else None,
            psks=[bytes.fromhex(p) for p in base.get(f"{prefix}_psks", [])],
        )

    parties = {"initiator": side("init", True), "responder": side("resp", False)}
    hs = base["handshake_messages"]
    for index, message in enumerate(messages):
        rx = parties["responder" if message["sender"] == "initiator" else "initiator"]
        tx = parties[message["sender"]]
        ciphertext = bytes.fromhex(message["ciphertext"])
        failed = False
        try:
            if index < hs:
                tx.write_message(bytes.fromhex(message["payload"]))
                rx.read_message(ciphertext)
            else:
                rx.decrypt(ciphertext)
                if "replay" in case and case["replay"]["message"] == index:
                    rx.decrypt(ciphertext)
        except Exception:  # noqa: BLE001 - any rejection counts
            failed = True
        if failed:
            assert index == case["fail_at"], (case["name"], index)
            return case
    raise AssertionError(f"negative case {case['name']} did not fail")


def seal_segments(purpose: str, object_id: str, key_bytes: bytes, plaintext: bytes) -> list[dict]:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    aead = AESGCM(key_bytes)
    size = 64 * 1024
    chunks = [plaintext[i:i + size] for i in range(0, len(plaintext), size)] or [b""]
    out = []
    for index, chunk in enumerate(chunks):
        final = index == len(chunks) - 1
        nonce = bytes(4) + index.to_bytes(8, "big")
        ad = prologue(purpose, object_id, str(index)) + (b"\0\x01" if final else b"\0\x00")
        ciphertext = aead.encrypt(nonce, chunk, ad)
        entry = {"index": index, "final": final, "nonce": nonce.hex(), "ad": ad.hex(),
                 "ciphertextLength": len(ciphertext), "ciphertextSha256": hashlib.sha256(ciphertext).hexdigest()}
        if len(ciphertext) <= 64:
            entry["ciphertext"] = ciphertext.hex()
        out.append(entry)
    return out


def pattern_bytes(length: int) -> bytes:
    return bytes((i * 31 + 7) & 0xFF for i in range(length))


def format_vectors() -> dict:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    identities = []
    for label in ("client static", "device static", "other client"):
        pub = x25519_public(key(label))
        identities.append({"identityPub": pub.hex(), "identityPubB64": b64url(pub),
                           "clientId": client_id_for(pub), "fingerprint": fingerprint(pub)})

    directory_key = key("directory key epoch 3")
    envelopes = []
    for index, (session_id, slot, payload) in enumerate([
        ("sess_vector", "device", {"title": "修复登录页", "latest": "已完成 3 个文件的修改", "cwd": "/Users/me/app"}),
        ("sess_vector", "user", {"title": "我的标题"}),
    ]):
        key_id = "dk_vector_3"
        nonce = hashlib.sha256(f"display nonce {index}".encode()).digest()[:12]
        plaintext = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
        ad = prologue("display", "dev_vector", session_id, slot, key_id)
        sealed = nonce + AESGCM(directory_key).encrypt(nonce, plaintext, ad)
        envelopes.append({"deviceId": "dev_vector", "sessionId": session_id, "slot": slot, "keyId": key_id,
                          "directoryKey": directory_key.hex(), "nonce": nonce.hex(),
                          "plaintext": plaintext.decode(), "ad": ad.hex(), "payload": b64url(sealed)})

    sealed_objects = []
    for purpose, object_id, length in (("attachment", "file_small", 21), ("attachment", "file_empty", 0),
                                       ("share", "share_vector", 64 * 1024 + 100)):
        object_key = key(f"{purpose} key {object_id}")
        sealed_objects.append({"purpose": purpose, "objectId": object_id, "key": object_key.hex(),
                               "keyB64": b64url(object_key), "plaintextLength": length,
                               "segments": seal_segments(purpose, object_id, object_key, pattern_bytes(length))})

    digest_key = hmac.new(directory_key, prologue("input-digest"), hashlib.sha256).digest()
    digests = []
    for body in ('{"content":"hello","clientMessageId":"m_1"}', '{"decision":"approve"}'):
        mac = hmac.new(digest_key, body.encode(), hashlib.sha256).digest()
        digests.append({"directoryKey": directory_key.hex(), "body": body, "digestKey": digest_key.hex(),
                        "inputDigest": "hmac-sha256:" + b64url(mac)})

    body_max = 65535 - 16 - 1
    framing = []
    for length in (0, 1, body_max, body_max + 1, 150000):
        sizes = [body_max] * (length // body_max)
        rest = length - sum(sizes)
        if rest or not sizes:
            sizes.append(rest)
        framing.append({"messageLength": length,
                        "frames": [{"flag": 1 if i == len(sizes) - 1 else 0, "bodyLength": n}
                                   for i, n in enumerate(sizes)]})

    pairing_payload = {"v": 1, "deviceId": "dev_vector", "deviceIdentityPub": identities[1]["identityPubB64"],
                       "pairingId": "pair_vector", "psk": b64url(key("pairing psk")),
                       "serverUrl": "https://aa.example.com", "e2eeMode": "required",
                       "expiresAt": "2026-11-16T00:10:00Z"}
    pairing_json = json.dumps(pairing_payload, separators=(",", ":"))

    return {
        "version": "1.0",
        "generator": "contracts/e2ee/1.0/vectors/generate.py (hashlib, hmac, cryptography)",
        "rules": {
            "label": "UTF-8 of 'aa-e2ee/1.0' and the fields, joined with NUL",
            "clientId": "'cli_' + lowercase base32(SHA-256(label('client-id') || 0x00 || identityPub))[:26]",
            "fingerprint": "first 32 hex digits of SHA-256(identityPub), 8 groups of 4, space separated",
            "displayEnvelope": "payload = base64url(nonce12 || AES-256-GCM(directoryKey, nonce, plaintextJson, "
            "ad=label('display', deviceId, sessionId, slot, keyId))); nonce is random per seal",
            "sealedSegments": "64 KiB plaintext segments (an empty object is one empty segment); nonce = 4 zero "
            "bytes || index as 8-byte big endian; ad = label(purpose, objectId, index) || 0x00 || final(0x01/0x00)",
            "inputDigest": "'hmac-sha256:' + base64url(HMAC-SHA256(HMAC-SHA256(directoryKey, "
            "label('input-digest')), exact body bytes))",
            "framing": "transport plaintext = flag || body; bodies are at most 65518 bytes; 0x00 more follows, "
            "0x01 last fragment, 0x02 rekey (empty body)",
            "plaintextPattern": "byte i of a sealed-object plaintext is (i*31+7) & 0xff",
        },
        "identities": identities,
        "prologues": [
            {"kind": "pair", "fields": ["dev_vector", "pair_vector", identities[0]["clientId"], "c_1"],
             "bytes": prologue("pair", "dev_vector", "pair_vector", identities[0]["clientId"], "c_1").hex()},
            {"kind": "connect", "fields": ["dev_vector", identities[0]["clientId"], "c_1"],
             "bytes": prologue("connect", "dev_vector", identities[0]["clientId"], "c_1").hex()},
        ],
        "displayEnvelopes": envelopes,
        "sealedObjects": sealed_objects,
        "inputDigests": digests,
        "framing": framing,
        "pairingUri": {"payload": pairing_payload,
                       "uri": "aa-pair://" + b64url(pairing_json.encode()), "json": pairing_json},
    }


def official_vectors() -> dict:
    selected = []
    sources = []
    for source in OFFICIAL_SOURCES:
        with urllib.request.urlopen(source["url"]) as response:  # noqa: S310 - pinned https URL
            raw = response.read()
        sources.append({**source, "sha256": hashlib.sha256(raw).hexdigest()})
        for vector in json.loads(raw)["vectors"]:
            name = vector.get("protocol_name") or vector.get("name")
            if name and FUNDAMENTAL.match(name) and "fail" not in vector:
                selected.append({"source": source["name"], **vector})
    return {
        "suite": SUITE,
        "selection": "fundamental patterns (N, K, X, NN…IX) with optional psk modifiers, suite " + SUITE,
        "sources": sources,
        "vectors": selected,
    }


def dump(document: dict) -> str:
    return json.dumps(document, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail if aa-noise.json is stale")
    parser.add_argument("--refresh-official", action="store_true", help="re-download noise-official.json")
    args = parser.parse_args()

    for name, build in (("aa-noise.json", aa_vectors), ("aa-formats.json", format_vectors)):
        path = HERE / name
        text = dump(build())
        if args.check:
            if not path.exists() or path.read_text() != text:
                print(f"{path} is stale; run generate.py", file=sys.stderr)
                return 1
            print(f"{name} is up to date")
        else:
            path.write_text(text)
            print(f"wrote {path}")
    if args.refresh_official:
        official_path = HERE / "noise-official.json"
        official_path.write_text(dump(official_vectors()))
        print(f"wrote {official_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
