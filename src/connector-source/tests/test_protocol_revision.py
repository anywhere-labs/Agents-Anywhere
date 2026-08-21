from __future__ import annotations

from connector.server.protocol_revision import ProtocolRevisionClock


def test_protocol_revision_is_strictly_monotonic_when_clock_stalls() -> None:
    clock = ProtocolRevisionClock(lambda: 100)

    assert [clock.next(), clock.next(), clock.next()] == [100, 101, 102]


def test_protocol_revision_does_not_move_backward_with_system_clock() -> None:
    values = iter([200, 150, 250])
    clock = ProtocolRevisionClock(lambda: next(values))

    assert [clock.next(), clock.next(), clock.next()] == [200, 201, 250]
