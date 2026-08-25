from __future__ import annotations

import pytest
from connector.runtime_protocol import MAX_CONFIG_REVISION
from connector.runtimes.catalog_revisions import runtime_catalog_revision


def test_millisecond_config_revision_produces_js_safe_catalog_revision() -> None:
    revision = runtime_catalog_revision(1_786_665_600_123, 999)

    assert revision == 1_786_665_600_123_999
    assert revision <= MAX_CONFIG_REVISION


def test_max_config_revision_saturates_at_js_safe_catalog_boundary() -> None:
    assert runtime_catalog_revision(MAX_CONFIG_REVISION, 999) == MAX_CONFIG_REVISION


@pytest.mark.parametrize(
    ("config_revision", "static_revision", "error_type"),
    [
        (True, 1, TypeError),
        (-1, 1, ValueError),
        (MAX_CONFIG_REVISION + 1, 1, ValueError),
        (1, True, TypeError),
        (1, -1, ValueError),
        (1, 1000, ValueError),
    ],
)
def test_catalog_revision_rejects_invalid_components(
    config_revision: object,
    static_revision: object,
    error_type: type[Exception],
) -> None:
    with pytest.raises(error_type):
        runtime_catalog_revision(  # type: ignore[arg-type]
            config_revision,
            static_revision,
        )
