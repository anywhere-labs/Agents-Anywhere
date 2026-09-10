from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def test_connector_cli_starts_without_unix_pwd_module() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys; sys.modules['pwd'] = None; "
                "from connector.cli import main; main(['--help'])"
            ),
        ],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        check=False,
        text=True,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr
    assert "usage:" in result.stdout
