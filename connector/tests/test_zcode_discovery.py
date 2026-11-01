from connector.runtimes.zcode.discovery import discover_zcode, electron_node_exec


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


def _fake_app(tmp_path, *, with_helper):
    """搭建最小 .app 布局：返回 (entry, 主程序, Helper 或 None)。"""
    app = tmp_path / "Fake.app"
    main = app / "Contents/MacOS" / "Fake"
    main.parent.mkdir(parents=True)
    main.write_text("", encoding="utf-8")
    helper = None
    if with_helper:
        helper = (app / "Contents/Frameworks/Fake Helper.app"
                  / "Contents/MacOS/Fake Helper")
        helper.parent.mkdir(parents=True)
        helper.write_text("", encoding="utf-8")
    entry = app / "Contents/Resources/glm/zcode.cjs"
    entry.parent.mkdir(parents=True)
    entry.write_text("", encoding="utf-8")
    return entry, main, helper


def test_electron_node_prefers_lsuielement_helper(tmp_path):
    # Helper 带 LSUIElement，不会被注册成前台应用（Dock 上不出现 exec 图标）
    entry, _main, helper = _fake_app(tmp_path, with_helper=True)
    assert electron_node_exec(entry) == str(helper)


def test_electron_node_falls_back_to_main_binary(tmp_path):
    entry, main, _ = _fake_app(tmp_path, with_helper=False)
    assert electron_node_exec(entry) == str(main)


def test_electron_node_outside_app_is_none(tmp_path):
    orphan = tmp_path / "zcode.cjs"
    orphan.write_text("", encoding="utf-8")
    assert electron_node_exec(orphan) is None
