"""Server defaults without replacing application-installed diagnostic sinks."""

import os
import sys

from loguru import logger


def configure_server_logging() -> None:
    """Replace Loguru's automatic DEBUG sink; preserve explicitly installed sinks."""
    if os.environ.get("LOGURU_AUTOINIT", "true").strip().lower() in {"0", "false", "no", "off", "n"}:
        return
    try:
        logger.remove(0)
    except ValueError:
        return
    # The default sink lives for the process, beyond temporary stderr captures.
    logger.add(sys.__stderr__ or sys.stderr, level=os.environ.get("LOGURU_LEVEL", "INFO"))
