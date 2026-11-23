from __future__ import annotations

import pytest

from aa_control.core.drive import (
    MAX_DRIVE_NAME_CHARS,
    dedupe_drive_name,
    default_transfer_path,
    drive_ancestors,
    drive_basename,
    drive_parent,
    format_drive_ref,
    is_orches_path,
    is_within_drive_path,
    join_drive_path,
    normalize_drive_name,
    normalize_drive_path,
    orches_drive_path,
    parse_drive_ref,
    safe_drive_name,
    split_drive_name,
    system_folder_kind,
)
from aa_control.core.errors import ValidationError


def test_normalize_drive_path_canonical_forms() -> None:
    assert normalize_drive_path("/报告/2026/q3.pdf") == "/报告/2026/q3.pdf"
    assert normalize_drive_path("报告//2026/q3.pdf/") == "/报告/2026/q3.pdf"
    assert normalize_drive_path("\\a\\b.txt") == "/a/b.txt"
    assert normalize_drive_path("  / a /b  ") == "/a/b"
    assert normalize_drive_path("") == "/"
    assert normalize_drive_path("///") == "/"
    # macOS hands out decomposed (NFD) names; paths are stored composed (NFC)
    assert normalize_drive_path("/Cafe\u0301.txt") == "/Caf\u00e9.txt"
    # Case is kept and significant; % ? # and spaces are ordinary name characters
    assert normalize_drive_path("/Q3 (1)/100%?#.md") == "/Q3 (1)/100%?#.md"
    assert normalize_drive_name("  notes.md ") == "notes.md"


@pytest.mark.parametrize(
    "bad",
    [
        "/a/../b",
        "/./a",
        "..",
        "/a/b\x00c",
        "/a/b\x07",
        "/a/\ud800",
        "/a/ /b",
        "/" + "x" * (MAX_DRIVE_NAME_CHARS + 1),
        "/" + "/".join(["d"] * 33),
        "/" + "/".join(["x" * 200] * 6),
    ],
)
def test_normalize_drive_path_rejects_invalid_paths(bad: str) -> None:
    with pytest.raises(ValidationError) as exc:
        normalize_drive_path(bad)
    assert exc.value.code == "drive_invalid_path"


def test_drive_path_helpers() -> None:
    assert drive_parent("/a/b/c.txt") == "/a/b"
    assert drive_parent("/a") == "/"
    assert drive_parent("/") == "/"
    assert drive_basename("/a/b/c.txt") == "c.txt"
    assert drive_basename("/") == ""
    assert join_drive_path("/", "a") == "/a"
    assert join_drive_path("/a", "b") == "/a/b"
    assert drive_ancestors("/a/b/c.txt") == ["/a", "/a/b"]
    assert drive_ancestors("/a") == []
    assert is_within_drive_path("/a/b", "/a")
    assert is_within_drive_path("/a", "/a")
    assert is_within_drive_path("/anything", "/")
    assert not is_within_drive_path("/ab", "/a")
    assert system_folder_kind("/Transfers") == "transfers"
    assert system_folder_kind("/Orches") == "orches"
    assert system_folder_kind("/Orches/workspace") is None
    assert is_orches_path("/Orches") and is_orches_path("/Orches/workspace/a.md")
    assert not is_orches_path("/OrchesNotes") and not is_orches_path("/orches")


def test_duplicate_names_get_numbered_before_the_extension() -> None:
    assert split_drive_name("q3.pdf") == ("q3", ".pdf")
    assert split_drive_name("archive.tar.gz") == ("archive", ".tar.gz")
    assert split_drive_name(".env") == (".env", "")
    assert split_drive_name("README") == ("README", "")

    assert dedupe_drive_name("q3.pdf", set()) == "q3.pdf"
    assert dedupe_drive_name("q3.pdf", {"q3.pdf"}) == "q3 (1).pdf"
    assert dedupe_drive_name("q3.pdf", {"q3.pdf", "q3 (1).pdf"}) == "q3 (2).pdf"
    assert dedupe_drive_name("archive.tar.gz", {"archive.tar.gz"}) == "archive (1).tar.gz"
    assert dedupe_drive_name(".env", {".env"}) == ".env (1)"
    longest = "x" * (MAX_DRIVE_NAME_CHARS - 4) + ".pdf"
    renamed = dedupe_drive_name(longest, {longest})
    assert len(renamed) <= MAX_DRIVE_NAME_CHARS and renamed.endswith(" (1).pdf")


def test_safe_drive_name_never_fails() -> None:
    assert safe_drive_name(None, "drv_1") == "drv_1"
    assert safe_drive_name("  ", "drv_1") == "drv_1"
    assert safe_drive_name("..", "drv_1") == "drv_1"
    assert safe_drive_name("C:\\Users\\me\\q3.pdf", "drv_1") == "q3.pdf"
    assert safe_drive_name("bad\x07name.txt", "drv_1") == "bad_name.txt"
    long_name = safe_drive_name("y" * 400 + ".docx", "drv_1")
    assert len(long_name) == MAX_DRIVE_NAME_CHARS and long_name.endswith(".docx")
    assert default_transfer_path("build.tar.gz", "drv_1") == "/Transfers/build.tar.gz"
    assert default_transfer_path(None, "drv_1") == "/Transfers/drv_1"


def test_orches_paths_mirror_vfs_paths() -> None:
    assert orches_drive_path("workspace/notes.md", "drv_1") == "/Orches/workspace/notes.md"
    # No plaintext vfs_path (encrypted upload) or one that is no valid drive path: the file id, never a guess
    assert orches_drive_path(None, "drv_1") == "/Orches/drv_1"
    assert orches_drive_path("workspace/bad\x01name.md", "drv_1") == "/Orches/drv_1"
    assert orches_drive_path("/".join(["d"] * 40), "drv_1") == "/Orches/drv_1"


def test_drive_references_format_canonically() -> None:
    assert format_drive_ref("/") == "drive:/"
    assert format_drive_ref("/报告/2026/q3.pdf") == "drive:/报告/2026/q3.pdf"
    assert format_drive_ref("报告/2026/q3.pdf") == "drive:/报告/2026/q3.pdf"
    assert format_drive_ref("/Transfers/q3 (1).pdf") == "drive:/Transfers/q3%20%281%29.pdf"
    assert format_drive_ref("/a/100%.txt") == "drive:/a/100%25.txt"
    assert format_drive_ref("/a/why?#.md") == "drive:/a/why%3F%23.md"
    assert format_drive_ref("/a/[x]|<y>.md") == "drive:/a/%5Bx%5D%7C%3Cy%3E.md"
    assert format_drive_ref("/a/Bob's \"plan\".md") == "drive:/a/Bob%27s%20%22plan%22.md"
    assert format_drive_ref("/a/b\u3000c") == "drive:/a/b%E3%80%80c"  # ideographic space
    assert format_drive_ref("/a/\u202etxt.exe") == "drive:/a/%E2%80%AEtxt.exe"  # bidi override


@pytest.mark.parametrize(
    "path",
    [
        "/",
        "/报告/2026/q3.pdf",
        "/Transfers/q3 (1).pdf",
        "/a/100%.txt",
        "/a/%20literal.txt",
        "/a/why?#.md",
        "/emoji/🚀 launch.md",
        "/a/Bob's [draft] (v2).md",
        "/a/tab\u3000space.md",
    ],
)
def test_drive_references_round_trip(path: str) -> None:
    assert parse_drive_ref(format_drive_ref(path)) == path


def test_parse_drive_ref_is_lenient_with_hand_written_references() -> None:
    assert parse_drive_ref("DRIVE:/a/b.txt") == "/a/b.txt"
    assert parse_drive_ref("  drive:/报告/q3 final.pdf ") == "/报告/q3 final.pdf"
    assert parse_drive_ref("drive:/100%.txt") == "/100%.txt"  # a stray % stays literal
    assert parse_drive_ref("drive:/%E6%8A%A5%E5%91%8A/") == "/报告"
    assert parse_drive_ref("drive:/a//b") == "/a/b"


@pytest.mark.parametrize(
    "bad",
    [
        "/a/b.txt",
        "drive:",
        "drive:a/b.txt",
        "drive://host/a.txt",
        "drive:/a?b.txt",
        "drive:/a#b.txt",
        "drive:/%FF%FE.txt",
        "drive:/a/../b.txt",
        "drive:/a%00b.txt",
    ],
)
def test_parse_drive_ref_rejects_invalid_references(bad: str) -> None:
    with pytest.raises(ValidationError) as exc:
        parse_drive_ref(bad)
    assert exc.value.code == "drive_invalid_ref"
