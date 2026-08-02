from __future__ import annotations


class RuntimeDiscoveryReferenceOnlyError(RuntimeError):
    """Raised when old root-level runtime discovery is used by active code."""


def reference_only_runtime_discovery() -> None:
    raise RuntimeDiscoveryReferenceOnlyError(
        "root-level runtime discovery was moved to connector._reference; "
        "new runtimes must implement RuntimeProvider.discover()"
    )
