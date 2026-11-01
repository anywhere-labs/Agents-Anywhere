from connector.runtimes.zcode.discovery import discover_zcode


def test_finds_bundled_zcode_without_changing_user_data(tmp_path, monkeypatch):
    entry = tmp_path / "Contents/Resources/glm/zcode.cjs"
    entry.parent.mkdir(parents=True)
    entry.write_text("", encoding="utf-8")
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/node" if name == "node" else None)
    launch = discover_zcode(app_root=tmp_path)
    assert launch is not None
    assert launch.executable == "/usr/bin/node"
    assert launch.arguments == (str(entry), "app-server")


def test_accepts_cjs_cli_on_path(tmp_path, monkeypatch):
    entry = tmp_path / "zcode.cjs"
    entry.write_text("", encoding="utf-8")
    monkeypatch.setattr("shutil.which", lambda name: str(entry) if name == "zcode" else "/usr/bin/node")
    assert discover_zcode(app_root=tmp_path / "missing").arguments == (str(entry), "app-server")


def test_missing_zcode_is_not_available(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda name: None)
    assert discover_zcode(app_root=tmp_path) is None
