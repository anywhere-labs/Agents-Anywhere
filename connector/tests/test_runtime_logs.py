from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from connector.mesh.logs import LogHub, LogRecord, LogsService, LogWrite


def entry(index: int) -> LogWrite:
    return LogWrite(time="2026-10-19T00:00:00Z", level="info", name="bridge", message=f"event-{index}",
                    producer="plugin-instance", eventId=str(index))


def test_persist_reopen_deduplicate_and_clear_without_reusing_sequence(tmp_path):
    logs = LogHub(tmp_path)
    assert logs.append([entry(1), entry(2)], "bridge") == 2
    logs.close()
    logs = LogHub(tmp_path)
    assert logs.append([entry(2), entry(3)], "bridge") == 1
    assert [e.message for e in logs.read().items] == ["event-1", "event-2", "event-3"]
    last = logs.read().lastSeq
    logs.clear()
    logs.close()
    logs = LogHub(tmp_path)
    logs.append([entry(4)], "bridge")
    assert logs.read().items[0].seq > last
    if __import__('os').name != 'nt':
        assert tmp_path.stat().st_mode & 0o777 == 0o700
        assert all(p.stat().st_mode & 0o777 == 0o600 for p in tmp_path.iterdir())


def test_shared_store_serializes_independent_hosts_and_refreshes_caches(tmp_path):
    first, second = LogHub(tmp_path), LogHub(tmp_path)
    with ThreadPoolExecutor(2) as pool:
        list(pool.map(lambda pair: pair[0].append([entry(pair[1])], "bridge"),
                      [(first if i % 2 else second, i) for i in range(30)]))
    assert first.read().total == second.read().total == 30
    assert len({e.seq for e in first.read().items}) == 30
    first.clear()
    assert second.read().total == 0
    second.append([entry(31)], "bridge")
    assert first.read().items[0].seq > 30


def test_torn_last_batch_is_recovered_and_sequence_is_reserved(tmp_path):
    logs = LogHub(tmp_path)
    logs.append([entry(1)], "bridge")
    path = next(tmp_path.glob('runtime-*.jsonl'))
    with path.open('ab') as file:
        file.write(b'[{"seq":2')
    state = json.loads((tmp_path / 'state.json').read_text())
    (tmp_path / 'state.json').write_text(json.dumps({**state, 'seq': 2}))
    logs.close()
    logs = LogHub(tmp_path)
    logs.append([entry(3)], "bridge")
    assert [e.seq for e in logs.read().items] == [1, 3]


def test_retention_pages_source_and_tail_gap(tmp_path):
    logs = LogHub(tmp_path, max_rows=2)
    for i in range(4):
        logs.append([entry(i)], "bridge")
    assert logs.read().total <= 2
    assert logs.read(afterSeq=0, limit=1).hasMoreAfter
    connector = LogRecord(time="now", level="INFO", name="connector", message="ready")
    logs.append([connector], "connector")
    assert logs.read(source="connector").items[0].message == "ready"

    async def exercise():
        stream = LogsService(logs).tail(since=0)
        first = await anext(stream)
        await stream.aclose()
        assert first.gapBefore
    asyncio.run(exercise())


def test_redacts_credentials_before_persisting(tmp_path):
    logs = LogHub(tmp_path)
    logs.append([entry(1).model_copy(update={
        "message": ("Bearer abc_secret mk_host_secret connectorToken=plain_secret "
                    "Authorization: Connector conn_1:tok_secret"),
        "details": '{"connectorToken":"secret"}',
    })], "bridge")
    raw = next(tmp_path.glob('runtime-*.jsonl')).read_text()
    for secret in ("abc_secret", "mk_host_secret", "plain_secret", "tok_secret", "secret"):
        assert secret not in raw
    assert '"secret"' not in logs.read().items[0].details
    json.loads(logs.read().items[0].details)


def test_damaged_segment_is_truncated_instead_of_blocking_startup(tmp_path):
    logs = LogHub(tmp_path)
    logs.append([entry(1)], "bridge")
    logs.close()
    segment = next(tmp_path.glob('runtime-*.jsonl'))
    with segment.open('ab') as file:
        file.write(b'not-a-batch\n')
    repaired = LogHub(tmp_path)
    assert [item.message for item in repaired.read().items] == ["event-1"]
    repaired.append([entry(2)], "bridge")
    # The reserved sequence is recovered from the surviving rows.
    assert [item.seq for item in repaired.read().items] == [1, 2]


def test_damaged_state_does_not_block_startup(tmp_path):
    logs = LogHub(tmp_path)
    logs.append([entry(1)], "bridge")
    logs.close()
    (tmp_path / 'state.json').write_text('{not json')
    repaired = LogHub(tmp_path)
    assert [item.message for item in repaired.read().items] == ["event-1"]
    repaired.append([entry(2)], "bridge")
    assert [item.seq for item in repaired.read().items] == [1, 2]


def test_disk_failure_does_not_acknowledge_batch(tmp_path, monkeypatch):
    logs = LogHub(tmp_path)
    def fail():
        raise OSError("disk full")
    monkeypatch.setattr(logs.store, '_sync_directory', fail)
    with pytest.raises(OSError):
        logs.append([entry(1)], "bridge")
    assert logs.read().total == 0
