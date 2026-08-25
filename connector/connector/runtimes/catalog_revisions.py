from __future__ import annotations

from connector.runtime_protocol.instance_models import MAX_CONFIG_REVISION

CATALOG_CONFIG_REVISION_FACTOR = 1000


def runtime_catalog_revision(
    config_revision: int,
    static_catalog_revision: int,
) -> int:
    if isinstance(config_revision, bool) or not isinstance(config_revision, int):
        raise TypeError("config_revision must be an integer")
    if not 0 <= config_revision <= MAX_CONFIG_REVISION:
        raise ValueError("config_revision must be a non-negative safe integer")
    if isinstance(static_catalog_revision, bool) or not isinstance(
        static_catalog_revision, int
    ):
        raise TypeError("static_catalog_revision must be an integer")
    if not 0 <= static_catalog_revision < CATALOG_CONFIG_REVISION_FACTOR:
        raise ValueError(
            "static_catalog_revision must fit within the reserved revision range"
        )

    revision = (
        config_revision * CATALOG_CONFIG_REVISION_FACTOR + static_catalog_revision
    )
    if revision > MAX_CONFIG_REVISION:
        raise ValueError(
            "combined catalog revision exceeds the JavaScript safe integer limit"
        )
    return revision
