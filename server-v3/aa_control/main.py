from __future__ import annotations

import os

import uvicorn

from aa_control.app import create_app


def main() -> None:
    host = os.environ.get("AA_CONTROL_HOST", "0.0.0.0")
    port = int(os.environ.get("AA_CONTROL_PORT", "8080"))
    uvicorn.run(create_app(), host=host, port=port)


if __name__ == "__main__":
    main()
