from .definitions import AgentProfile

REQUIRED_WORK_DEVICES = frozenset(
    f"{system}-{arch}"
    for system in ("darwin", "linux", "win32")
    for arch in ("x64", "arm64")
)
REQUIRED_CLIENTS = frozenset({"web", "electron", "android", "ios"})


def verified_release(profile: AgentProfile, manifest: dict) -> bool:
    """Only call after verifying the publisher signature and local artifact."""
    acceptance = manifest.get("acceptance", {})
    return (
        manifest.get("profileId") == profile.id
        and profile.required_guarantees <= frozenset(manifest.get("guarantees", []))
        and profile.required_work_devices <= frozenset(acceptance.get("workDevices", []))
        and profile.required_clients <= frozenset(acceptance.get("clients", []))
    )


def release_available(profile: AgentProfile, guarantees: frozenset[str]) -> bool:
    return profile.release_ready and profile.required_guarantees <= guarantees


def effective_capability(
    *, advertised: bool, implemented: bool, ready: bool, allowed: bool = True
) -> dict:
    return {
        "supported": advertised and implemented,
        "available": advertised and implemented and ready,
        "allowed": allowed,
    }
