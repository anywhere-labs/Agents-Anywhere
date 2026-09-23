"""Benchmark the actual session/composer views in an isolated simulator app.

Requires a booted simulator. Temporarily instruments source files, restores them
even on failure, and uses a distinct bundle ID. Run from a dedicated worktree.
The baseline reinstates the old page-root draft observers in the same binary.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", required=True)
    parser.add_argument("--derived-data", default="/tmp/aa-pr75-build")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    ios = Path(__file__).resolve().parents[1]
    app = ios / "Agents Anywhere/Agents Anywhere"
    saved = {}
    env = dict(os.environ)
    bundle = "com.agentsanywhere.composerprobe"
    args.output.mkdir(parents=True, exist_ok=True)

    def replace(relative, old, new):
        path = app / relative
        source = path.read_text()
        assert source.count(old) == 1, f"Probe hook changed: {relative}: {old}"
        saved.setdefault(path, source)
        path.write_text(source.replace(old, new))

    def run(*command, **kwargs):
        return subprocess.run(command, check=True, env=env, **kwargs)

    try:
        entry = app / "App/AgentsAnywhereApp.swift"
        saved[entry] = entry.read_text()
        entry.write_text((ios / "Tests/ComposerDraftAudit/ComposerDraftProbe.swift").read_text())
        page = "Views/Chat/SessionChatView.swift"
        replace(page, "sessionIdentity = session", "_hasStartedLoading = State(initialValue: true)\n        sessionIdentity = session")
        replace(page, "chat.onEditCreation =", "ComposerProbe.configure(chat)\n            chat.onEditCreation =")
        replace(page, "var body: some View {", 'var body: some View {\n        let _ = ComposerProbe.hit("page")')
        replace(page, "guard !hasStartedLoading, !defersOpening else { return }", "return // Offline probe supplies its own loaded snapshot.")
        replace(page, "guard hasStartedLoading else { return }", "return // No network requests in the probe.")
        replace(page, "onDraftChange: { model.repository.draftDidChange() }", "onDraftChange: { if !ComposerProbe.legacy { model.repository.draftDidChange() } }")
        replace(page, ".onChange(of: session.failure, initial: true)",
                '.onChange(of: ComposerProbe.legacy ? session.composer.text : "") { _, _ in model.repository.draftDidChange() }\n'
                '        .onChange(of: ComposerProbe.legacy ? session.composer.attachments : []) { _, _ in model.repository.draftDidChange() }\n'
                '        .onChange(of: session.failure, initial: true)')
        replace("Models/Chat/SessionChatModel.swift", "func prepareOpening() async {",
                "func prepareComposerProbe() { isOpeningPrepared = true }\n\n    func prepareOpening() async {")
        replace("Views/Chat/ChatTimelineView.swift", "var body: some View {\n        // A sibling overlay",
                'var body: some View {\n        let _ = ComposerProbe.hit("timeline")\n        // A sibling overlay')
        replace("Views/Chat/Composer/ChatComposer.swift", "var body: some View {",
                'var body: some View {\n        let _ = ComposerProbe.hit("composer")')
        replace("Repositories/V2SessionRepository.swift", "func draftDidChange() { schedulePersistence() }",
                'func draftDidChange() { ComposerProbe.hit("persistence"); schedulePersistence() }')
        with (args.output / "build.log").open("w") as log:
            run("xcodebuild", "-project", str(ios / "Agents Anywhere/Agents Anywhere.xcodeproj"),
                "-scheme", "Agents Anywhere", "-configuration", "Release", "-sdk", "iphonesimulator",
                "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", args.derived_data,
                "CODE_SIGNING_ALLOWED=NO", f"PRODUCT_BUNDLE_IDENTIFIER={bundle}",
                "ONLY_ACTIVE_ARCH=YES", "ARCHS=arm64", "build", stdout=log, stderr=subprocess.STDOUT)
        product = Path(args.derived_data) / "Build/Products/Release-iphonesimulator/Agents Anywhere.app"
        run("xcrun", "simctl", "install", args.device, str(product))
        container = subprocess.check_output(["xcrun", "simctl", "get_app_container", args.device, bundle, "data"], env=env, text=True).strip()
        result = Path(container) / "Documents/composer-result.json"
        for index, baseline in enumerate([True, False, False, True, True, False]):
            subprocess.run(["xcrun", "simctl", "terminate", args.device, bundle], env=env, capture_output=True)
            result.unlink(missing_ok=True)
            env["SIMCTL_CHILD_AA_COMPOSER_BASELINE"] = "1" if baseline else "0"
            run("xcrun", "simctl", "launch", args.device, bundle)
            deadline = time.monotonic() + 90
            while not result.exists() and time.monotonic() < deadline:
                time.sleep(0.5)
            value = json.loads(result.read_text())
            assert "error" not in value, value
            assert value["markedUpdates"] == 120 and value["draftMatchesEditor"] and value["attachmentCallback"], value
            assert value["counts"]["persistence"] == 120, value
            page_updates = value["counts"].get("page", 0)
            assert page_updates >= 100 if baseline else page_updates < 10, value
            (args.output / f"{index + 1}-{'baseline' if baseline else 'fixed'}.json").write_text(json.dumps(value, indent=2) + "\n")
            print(json.dumps(value), flush=True)
    finally:
        for path, source in saved.items():
            path.write_text(source)
        subprocess.run(["xcrun", "simctl", "terminate", args.device, bundle], env=env, capture_output=True)


if __name__ == "__main__":
    main()
