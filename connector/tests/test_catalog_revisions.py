from __future__ import annotations

from connector.runtimes.catalog_revisions import runtime_catalog_revision
from connector.server.protocol import PROTOCOL_MAX_REVISION


def test_millisecond_config_revision_produces_js_safe_catalog_revision() -> None:
    config_revision = 1_786_665_600_123

    revision = runtime_catalog_revision(config_revision, 999)

    assert revision == 1_786_665_600_123_999
    assert revision <= PROTOCOL_MAX_REVISION
