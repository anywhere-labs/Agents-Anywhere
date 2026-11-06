import os
from pathlib import Path


async def materialize(host, root, sid, request):
    objective = request["objective"]
    refs = request.get("attachments") or []
    if not refs:
        return objective
    import hashlib

    directory = (
        root
        / "goal-assets"
        / hashlib.sha256(sid.encode()).hexdigest()
        / hashlib.sha256(request["operationId"].encode()).hexdigest()
    )
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    paths = []
    for i, ref in enumerate(refs):
        content = await host.attachment_download(sid, ref["fileId"])
        name = (
            Path(content.name).name.replace("\n", "_").replace("\r", "_")
            or "attachment"
        )
        path = directory / f"{i}-{name}"
        temporary = path.with_name(path.name + ".tmp")
        with temporary.open("wb") as stream:
            stream.write(content.content)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o600)
        temporary.replace(path)
        paths.append(str(path))
    return objective + "\n\n" + "\n".join(paths)
