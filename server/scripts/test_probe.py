"""Pytest reporting and worker configuration for scripts.check_tests.

Loaded before conftest so each worker resolves its own database at import time.
"""

from __future__ import annotations

import json
import os
from pathlib import Path


def pytest_load_initial_conftests(early_config, parser, args):
    worker = os.environ.get("PYTEST_XDIST_WORKER", "master")
    databases = json.loads(os.environ["AA_CHECK_DATABASES"])
    os.environ["AGENT_SERVER_TEST_DB_URL"] = databases[worker]
    os.environ["AGENT_SERVER_DB_URL"] = databases[worker]


def pytest_configure(config):
    config._aa_selected = []


def pytest_xdist_node_collection_finished(node, ids):
    node.config._aa_selected = sorted(set(node.config._aa_selected) | set(ids))


def pytest_collection_finish(session):
    session.config._aa_selected = [item.nodeid for item in session.items]


def pytest_runtest_logreport(report):
    # Controller also receives reports from xdist workers.
    _reports.append(
        {
            "id": report.nodeid,
            "phase": report.when,
            "outcome": report.outcome,
            "seconds": report.duration,
        }
    )


_reports = []


def pytest_sessionfinish(session, exitstatus):
    config = session.config
    if hasattr(config, "workerinput"):
        return
    path = Path(os.environ["AA_CHECK_STAGE_REPORT"])
    path.write_text(
        json.dumps(
            {
                "exit_code": int(exitstatus),
                "selected": config._aa_selected,
                "reports": _reports,
            },
            indent=2,
        )
    )
