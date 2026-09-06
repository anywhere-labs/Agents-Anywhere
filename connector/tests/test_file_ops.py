from __future__ import annotations

import asyncio
import os

import pytest

from connector.local.common import MAX_DIR_ENTRIES
from connector.local.file_ops import FileOps


def read_dir(root, path: str):
    return asyncio.run(FileOps().read_dir({"root": str(root), "path": path}))


def test_read_dir_reports_canonical_target_before_directory_fallback(tmp_path) -> None:
    source = tmp_path / "src"
    source.mkdir()
    main_file = source / "main.ts"
    main_file.write_text("export {}\n")

    directory_result = read_dir(tmp_path, "src")
    assert directory_result["targetPath"] == str(source.resolve())
    assert directory_result["targetType"] == "directory"
    assert directory_result["path"] == str(source.resolve())

    file_result = read_dir(tmp_path, "src/main.ts")
    assert file_result["targetPath"] == str(main_file.resolve())
    assert file_result["targetType"] == "file"
    assert file_result["path"] == str(source.resolve())

    missing_target = tmp_path / "missing" / "deep" / "main.ts"
    missing_result = read_dir(tmp_path, "missing/deep/main.ts")
    assert missing_result["targetPath"] == str(missing_target.resolve())
    assert missing_result["targetType"] == "missing"
    assert missing_result["path"] == str(tmp_path.resolve())


def test_read_dir_keeps_the_requested_file_visible_when_its_parent_is_truncated(tmp_path) -> None:
    large_directory = tmp_path / "large"
    large_directory.mkdir()
    for index in range(MAX_DIR_ENTRIES):
        (large_directory / f"a-{index:04d}.txt").touch()
    target = large_directory / "zz-target.txt"
    target.write_text("target\n")

    result = read_dir(tmp_path, "large/zz-target.txt")

    assert result["targetType"] == "file"
    assert result["truncated"] is True
    assert len(result["entries"]) == MAX_DIR_ENTRIES
    assert any(entry["path"] == str(target.resolve()) for entry in result["entries"])


@pytest.mark.skipif(os.name == "nt", reason="symlink creation is not reliably available on Windows CI")
def test_read_dir_reports_final_symlink_target_type_and_path(tmp_path) -> None:
    real_directory = tmp_path / "real" / "docs"
    real_directory.mkdir(parents=True)
    real_file = real_directory / "README.md"
    real_file.write_text("# Docs\n")

    directory_link = tmp_path / "linked-docs"
    directory_link.symlink_to(real_directory, target_is_directory=True)
    directory_result = read_dir(tmp_path, "linked-docs")
    assert directory_result["targetPath"] == str(real_directory.resolve())
    assert directory_result["targetType"] == "directory"
    assert directory_result["path"] == str(real_directory.resolve())

    file_link = tmp_path / "readme-link"
    file_link.symlink_to(real_file)
    file_result = read_dir(tmp_path, "readme-link")
    assert file_result["targetPath"] == str(real_file.resolve())
    assert file_result["targetType"] == "file"
    assert file_result["path"] == str(real_directory.resolve())

    missing_target = tmp_path / "missing-target"
    broken_link = tmp_path / "broken-link"
    broken_link.symlink_to(missing_target)
    broken_result = read_dir(tmp_path, "broken-link")
    assert broken_result["targetPath"] == str(missing_target.resolve())
    assert broken_result["targetType"] == "missing"
    assert broken_result["path"] == str(tmp_path.resolve())
