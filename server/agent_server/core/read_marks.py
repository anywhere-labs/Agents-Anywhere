"""Unread marks: ``sessions.read_seq`` against the device's ``latest_turn_end_seq``.

v2 compared the read mark with the Server's own sequence. v3 sequences are the
device's clock, which restarts above v2's numbers after the upgrade, so v2_60
replaced every old mark with one of two sentinels. The first
``latestTurnEndSeq`` a v3 device reports turns a sentinel into a real position;
a session whose device never upgrades keeps its sentinel.
"""

from __future__ import annotations

READ_TO_LATEST = -1
"""Read when migrated: read until the device reports, then read up to that turn."""

UNREAD = -2
"""Unread when migrated: unread until the device reports, then one turn behind it."""


def is_unread(read_seq: int, latest_turn_end_seq: int) -> bool:
    if read_seq == READ_TO_LATEST:
        return False
    if read_seq == UNREAD:
        return True
    return latest_turn_end_seq > read_seq


def visible_read_seq(read_seq: int, latest_turn_end_seq: int) -> int:
    """The ``lastReadSeq`` clients see: never a sentinel."""

    if read_seq == READ_TO_LATEST:
        return latest_turn_end_seq
    if read_seq == UNREAD:
        return max(latest_turn_end_seq - 1, 0)
    return read_seq

