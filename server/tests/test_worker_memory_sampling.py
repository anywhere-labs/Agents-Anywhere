from __future__ import annotations

from pathlib import Path

import pytest

from scripts.sample_worker_memory import sample, start_ticks, summarize_smaps


def mapping(address, size, rss, *, path="", inode=0):
    return (
        f"{address} rw-p 00000000 00:00 {inode} {path}\n"
        f"Size: {size} kB\nRss: {rss} kB\nPss: {rss} kB\n"
        f"Private_Dirty: {rss} kB\nAnonymous: {rss} kB\nSwap: 0 kB\n"
    )


def test_smaps_groups_resident_memory_without_exporting_paths():
    result = summarize_smaps(
        mapping("1000-2000", 4, 4, path="[heap]")
        + mapping("2000-102000", 1024, 512)
        + mapping("200000-4200000", 65536, 64)
        + mapping("5000000-5001000", 4, 4, path="[anon:example]")
        + mapping("6000000-6001000", 4, 4, path="/private/file", inode=42)
        + mapping("7000000-7001000", 4, 0, path="[stack]")
        + mapping("8000000-8001000", 4, 0, path="[vdso]")
    )
    assert result["heap"]["Rss"] == 4
    assert result["anonymous_1mib_mapping"]["Rss"] == 512
    assert result["anonymous_64mib_mapping"]["Rss"] == 64
    assert result["anonymous_other"]["Rss"] == 4
    assert result["file"]["Rss"] == 4
    assert result["stack"]["Rss"] == 0
    assert result["special"]["mappings"] == 1
    assert result["total"]["mappings"] == 7
    assert result["total"]["Rss"] == 588
    assert "/private/file" not in str(result)


def test_start_ticks_handles_spaces_and_parentheses_in_process_name(tmp_path: Path):
    # field 22 follows 19 fields after the parenthesized comm.
    (tmp_path / "stat").write_text("123 (worker (a) b) S " + "0 " * 18 + "456 0 0\n")
    assert start_ticks(tmp_path) == 456


def test_sampler_rejects_a_reused_pid_before_reading_smaps(monkeypatch):
    monkeypatch.setattr("scripts.sample_worker_memory.start_ticks", lambda _: 99)
    with pytest.raises(RuntimeError, match="reused"):
        sample(123, expected_start=98)


def test_sampler_rejects_a_pid_that_changes_during_smaps_read(monkeypatch):
    identities = iter([98, 99])
    monkeypatch.setattr("scripts.sample_worker_memory.start_ticks", lambda _: next(identities))
    monkeypatch.setattr(Path, "read_text", lambda _: mapping("1000-2000", 4, 4))
    with pytest.raises(RuntimeError, match="changed during"):
        sample(123, expected_start=98)
