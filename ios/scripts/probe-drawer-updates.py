"""Exercise the actual SwiftUI drawer with deterministic pan progress, headlessly."""

from pathlib import Path
import platform
import subprocess
import tempfile


def main() -> None:
    ios = Path(__file__).resolve().parents[1]
    app = ios / "Agents Anywhere/Agents Anywhere"
    components = app / "Views/Components"
    source = (components / "SidebarDrawer.swift").read_text()
    substitutions = {
        "@State private var progress: CGFloat": "@Binding private var progress: CGFloat",
        "_progress = State(initialValue: isOpen.wrappedValue ? 1 : 0)": "_progress = DrawerProbeControl.progress",
    }
    # Only replace the progress driver in a disposable copy; all layout, page
    # factories and motion modifiers remain the application's real code.
    for old, new in substitutions.items():
        assert source.count(old) == 1, f"Update the probe's progress hook: {old}"
        source = source.replace(old, new)
    sdk = subprocess.check_output(["xcrun", "--sdk", "macosx", "--show-sdk-path"], text=True).strip()
    with tempfile.TemporaryDirectory(prefix="aa-drawer-probe-") as folder:
        generated = Path(folder) / "SidebarDrawer.swift"
        generated.write_text(source)
        executable = Path(folder) / "probe"
        subprocess.run([
            "xcrun", "swiftc", "-parse-as-library", "-target", f"{platform.machine()}-apple-ios26.5-macabi",
            "-sdk", sdk, "-F", f"{sdk}/System/iOSSupport/System/Library/Frameworks",
            str(generated),
            *(str(components / name) for name in ["SidebarDrawerPanGesture.swift",
                "SidebarDrawerTranslation.swift", "SidebarDrawerCloseRegion.swift"]),
            str(app / "Models/Chat/DrawerInteractionState.swift"),
            str(ios / "Tests/DrawerUpdateProbe.swift"), "-o", str(executable),
        ], check=True)
        subprocess.run([str(executable)], check=True)


if __name__ == "__main__":
    main()
