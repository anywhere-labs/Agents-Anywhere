"""Copy a frozen local attachment snapshot to S3, preserving IDs and raw bytes.

Uses the server image's dependencies. Dry-run is the default. Source is never
modified; destination objects with different content cause a hard failure.
Keep the selected destination prefix exclusive during the migration.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from httpx_s3_client import AsyncS3Client, S3Config
from httpx_s3_client.exceptions import S3ObjectNotFoundError
from loguru import logger


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def inventory(root: Path) -> list[dict]:
    if not root.is_dir():
        raise ValueError("Source directory does not exist")
    records = []
    expected = set()
    for metadata_path in sorted(root.glob("*/*.json")):
        blob_path = metadata_path.with_suffix(".bin")
        if metadata_path.is_symlink() or blob_path.is_symlink() or metadata_path.parent.is_symlink():
            raise ValueError("Symlinks are not supported")
        raw = metadata_path.read_bytes()
        metadata = json.loads(raw)
        if metadata["sessionId"] != metadata_path.parent.name or metadata["fileId"] != metadata_path.stem:
            raise ValueError(f"ID mismatch: {metadata_path.name}")
        blob = blob_path.read_bytes()
        if len(blob) != metadata["size"] or digest(blob) != metadata["sha256"]:
            raise ValueError(f"Content integrity mismatch: {blob_path.name}")
        for path, data, media in ((blob_path, blob, metadata.get("mediaType") or "application/octet-stream"),
                                  (metadata_path, raw, "application/json")):
            relative = path.relative_to(root).as_posix()
            expected.add(relative)
            records.append({"path": relative, "bytes": len(data), "sha256": digest(data), "media_type": media})
    actual = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}
    if expected != actual:
        raise ValueError("Unpaired or unexpected files in source")
    if not records:
        raise ValueError("No attachments found")
    return records


async def copy_object(client, bucket: str, key: str, data: bytes, media_type: str) -> str:
    try:
        existing = await client.get_object(bucket, key)
    except S3ObjectNotFoundError:
        existing = None
    if existing is not None:
        if existing != data:
            raise ValueError(f"Destination conflict; refusing overwrite: {key}")
        return "already_verified"
    await client.put_object(bucket, key, data, content_type=media_type)
    downloaded = await client.get_object(bucket, key)
    if downloaded != data:
        raise ValueError(f"Destination readback mismatch: {key}")
    return "uploaded_verified"


async def run(args) -> None:
    records = inventory(args.source)
    report = {"started_at": datetime.now(timezone.utc).isoformat(), "bucket": args.bucket,
              "prefix": args.prefix.strip("/"), "attachments": len(records) // 2,
              "object_count": len(records), "total_bytes": sum(r["bytes"] for r in records),
              "apply": args.apply, "complete": False, "objects": records}
    logger.info("Validated {} attachments / {} objects / {} bytes", report["attachments"], len(records), report["total_bytes"])
    if not args.apply:
        report["complete"] = True
        args.report.write_text(json.dumps(report, indent=2) + "\n")
        return
    config = S3Config(access_key=os.environ["AGENT_SERVER_FILES_S3_ACCESS_KEY"],
                      secret_key=os.environ["AGENT_SERVER_FILES_S3_SECRET_KEY"],
                      region=os.environ["AGENT_SERVER_FILES_S3_REGION"],
                      endpoint_url=os.environ["AGENT_SERVER_FILES_S3_ENDPOINT_URL"],
                      virtual_host_style=True)
    semaphore = asyncio.Semaphore(args.concurrency)
    done = 0
    async with AsyncS3Client(config) as client:
        async def transfer(record):
            nonlocal done
            async with semaphore:
                data = (args.source / record["path"]).read_bytes()
                if len(data) != record["bytes"] or digest(data) != record["sha256"]:
                    raise ValueError("Source changed after inventory")
                key = report["prefix"] + "/" + record["path"]
                for attempt in range(3):
                    try:
                        record["result"] = await copy_object(client, args.bucket, key, data, record["media_type"])
                        break
                    except ValueError:
                        raise
                    except Exception:
                        if attempt == 2:
                            raise
                        await asyncio.sleep(2 ** attempt)
                done += 1
                if done % 50 == 0 or done == len(records):
                    logger.info("Verified {}/{} objects", done, len(records))
        results = await asyncio.gather(*(transfer(r) for r in records), return_exceptions=True)
        errors = [f"{type(r).__name__}: {r}" for r in results if isinstance(r, BaseException)]
    report["complete"] = not errors
    report["errors"] = errors
    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    if errors:
        raise RuntimeError(f"{len(errors)} objects failed; inspect report, then resume with the same source/prefix")
    logger.info("Migration complete; every destination object read back and verified")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if not args.prefix.strip("/") or args.concurrency < 1:
        parser.error("A non-empty prefix and positive concurrency are required")
    asyncio.run(run(args))
