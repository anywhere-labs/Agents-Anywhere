from __future__ import annotations


CATALOG_CONFIG_REVISION_FACTOR = 1000


def runtime_catalog_revision(
    config_revision: int,
    static_catalog_revision: int,
) -> int:
    return config_revision * CATALOG_CONFIG_REVISION_FACTOR + static_catalog_revision
