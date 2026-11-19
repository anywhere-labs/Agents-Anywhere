import XCTest

/// Reference capture for aligning the Android glass with iOS (not a pass/fail test). Each test drives one set of
/// presses while the host records the screen (`xcrun simctl io <udid> recordVideo`) and takes PNG screenshots on
/// request. Driven by `.local-dev/v3poc/compare-ref/tools/run_ref_capture.sh`, which also starts the watcher that
/// turns `shot` marks into `simctl io screenshot` calls.
///
/// Runner environment (pass with the `TEST_RUNNER_` prefix to `xcodebuild test-without-building`):
/// - `AA_REF_SCHEME=dark|light` (app tests) — the app's scheme.
/// - `AA_REF_APP_ENV=K=V;K=V` — extra app launch variables (e.g. `AA_POC_BACKDROP=black`).
/// - `AA_REF_MARKS=/abs/marks.log` — where to append `<epoch> <kind> <payload>` lines (default /tmp/aav3poc-ref/marks.log).
/// - `AA_REF_STEP`, `AA_REF_STEPS`, `AA_REF_SETTLE` (testRefScroll / testRefPill) — drag distance in points, number of
///   drags, seconds to wait for the demo to finish first.
///
/// Mark kinds: `mark <label>` (an action starts now), `frame <name> x y w h` (element frame in points),
/// `shot <name> <delaySeconds>` (the host should take a screenshot after that delay).
final class RefCaptureTests: XCTestCase {
    private var marksPath: String {
        ProcessInfo.processInfo.environment["AA_REF_MARKS"] ?? "/tmp/aav3poc-ref/marks.log"
    }
    private var scheme: String { ProcessInfo.processInfo.environment["AA_REF_SCHEME"] ?? "dark" }

    override func setUp() {
        continueAfterFailure = true
        try? FileManager.default.createDirectory(atPath: (marksPath as NSString).deletingLastPathComponent,
                                                 withIntermediateDirectories: true)
    }

    // MARK: Marks

    private func write(_ line: String) {
        let text = String(format: "%.3f %@\n", Date().timeIntervalSince1970, line)
        if let handle = FileHandle(forWritingAtPath: marksPath) {
            handle.seekToEndOfFile(); handle.write(Data(text.utf8)); try? handle.close()
        } else {
            FileManager.default.createFile(atPath: marksPath, contents: Data(text.utf8))
        }
    }

    private func mark(_ label: String) { write("mark \(label)") }

    private func frame(_ name: String, _ element: XCUIElement) {
        guard element.exists else { write("frame \(name) missing"); return }
        let f = element.frame
        write(String(format: "frame %@ %.1f %.1f %.1f %.1f", name, f.minX, f.minY, f.width, f.height))
    }

    /// Ask the host for a screenshot `delay` seconds from now (the host's `simctl io screenshot` takes ~0.3–1 s).
    private func shot(_ name: String, after delay: Double = 0) { write(String(format: "shot %@ %.2f", name, delay)) }

    private func launchApp(_ extra: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["AA_POC_SCHEME"] = scheme
        for (key, value) in extra { app.launchEnvironment[key] = value }
        // `AA_REF_APP_ENV=AA_POC_BACKDROP=black;AA_POC_DRAWER=1`: more app launch variables.
        for pair in (ProcessInfo.processInfo.environment["AA_REF_APP_ENV"] ?? "").split(separator: ";") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            if kv.count == 2 { app.launchEnvironment[String(kv[0])] = String(kv[1]) }
        }
        app.launchEnvironment["AA_POC_DEMO"] = "1"
        app.launch()
        return app
    }

    // MARK: Press helpers

    private func coordinate(_ element: XCUIElement, dx: CGFloat = 0.5, dy: CGFloat = 0.5) -> XCUICoordinate {
        element.coordinate(withNormalizedOffset: CGVector(dx: dx, dy: dy))
    }

    /// Hold `hold` seconds, then slide `dragBy` points away and lift there, so the control's action is cancelled.
    private func pressAndCancel(_ label: String, _ element: XCUIElement, dx: CGFloat = 0.5, hold: TimeInterval = 0.8,
                                dragBy: CGVector = CGVector(dx: 0, dy: 120), shotDuringHold: String? = nil) {
        let start = coordinate(element, dx: dx)
        let end = start.withOffset(dragBy)
        mark("\(label).down")
        if let shotDuringHold { shot(shotDuringHold, after: hold * 0.6) }
        start.press(forDuration: hold, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.3)
        mark("\(label).up")
    }

    /// Hold `hold` seconds and lift in place (the control's action runs).
    private func pressAndRelease(_ label: String, _ element: XCUIElement, dx: CGFloat = 0.5, hold: TimeInterval = 0.8) {
        mark("\(label).down")
        coordinate(element, dx: dx).press(forDuration: hold)
        mark("\(label).up")
    }

    // MARK: Chrome (toolbar, composer, approval dock)

    func testRefChrome() throws {
        let app = launchApp()
        let menu = app.buttons["打开侧栏"]
        let more = app.buttons["会话菜单"]
        let editor = app.textViews["chat.composer.editor"]
        let allow = app.buttons["允许"]
        XCTAssertTrue(menu.waitForExistence(timeout: 30))
        XCTAssertTrue(allow.waitForExistence(timeout: 60), "approval dock never appeared")
        sleep(3)
        frame("menu", menu); frame("more", more); frame("editor", editor); frame("allow", allow)
        frame("reject", app.buttons["拒绝"]); frame("always", app.buttons["本会话都允许"])
        frame("window", app.windows.firstMatch)
        shot("approval-rest")
        sleep(2)

        // Toolbar: hold then slide off (no action), off-centre holds, and one natural press (opens the drawer).
        pressAndCancel("menu.cancel", menu); sleep(2)
        pressAndCancel("menu.left", menu, dx: 0.2, hold: 1.5); sleep(2)
        pressAndCancel("menu.right", menu, dx: 0.8, hold: 1.5); sleep(2)
        pressAndCancel("menu.held", menu, hold: 3.0, shotDuringHold: "press-menu-held"); sleep(3)
        // The session menu opens on touch-down; slide up (away from its items, one of which is 停止) before lifting.
        pressAndCancel("more.cancel", more, dragBy: CGVector(dx: 0, dy: -60)); sleep(3)
        if app.buttons["会话详情"].exists { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55)).tap(); sleep(2) }
        pressAndRelease("menu.press", menu); sleep(3)
        let close = app.buttons["关闭侧栏"]
        if close.waitForExistence(timeout: 3) { close.tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap() }
        sleep(3)

        // Composer capsule. A press on the editor focuses it even after sliding off (and a long press on a focused editor
        // shows the text loupe), so the holds go on the 附件 (+) button, which a slide-off cancels; the one press on the
        // editor's right end is followed by dismissing the keyboard.
        let plus = app.buttons["附件与对话选项"]
        frame("plus", plus)
        func dismissKeyboard() {
            for _ in 0 ..< 3 where app.keyboards.count > 0 {
                mark("dismiss-keyboard")
                // The thread between the toolbar and the dock while the keyboard is up.
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.26)),
                           withVelocity: .slow, thenHoldForDuration: 0.1)
                sleep(3)
            }
        }
        pressAndCancel("composer.cancel", plus, dragBy: CGVector(dx: 0, dy: -150)); sleep(3); dismissKeyboard()
        pressAndCancel("composer.left", plus, hold: 1.5, dragBy: CGVector(dx: 0, dy: -150)); sleep(3); dismissKeyboard()
        pressAndCancel("composer.right", editor, dx: 0.95, hold: 1.5, dragBy: CGVector(dx: 0, dy: -150)); sleep(3); dismissKeyboard()
        pressAndCancel("composer.held", plus, hold: 3.0, dragBy: CGVector(dx: 0, dy: -150), shotDuringHold: "press-composer-held"); sleep(3); dismissKeyboard()

        // Approval buttons: cancelled holds first, then a real answer (the dock goes away).
        pressAndCancel("allow.cancel", allow, dragBy: CGVector(dx: 0, dy: -160)); sleep(2)
        pressAndCancel("reject.cancel", app.buttons["拒绝"], dragBy: CGVector(dx: 0, dy: -160)); sleep(2)
        pressAndCancel("allow.held", allow, hold: 3.0, dragBy: CGVector(dx: 0, dy: -160), shotDuringHold: "press-allow-held"); sleep(3)
        pressAndRelease("allow.press", allow); sleep(4)

        // The session menu (opens on touch).
        dismissKeyboard()
        mark("more.tap"); more.tap(); shot("menu", after: 1.5); sleep(4)
        frame("menu.first", app.buttons["会话详情"])
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55)).tap(); sleep(2)

        // Composer press → focus, then a line of text with the keyboard up and down.
        pressAndRelease("composer.press", editor); sleep(3)
        editor.typeText("帮我看看这个测试为什么不稳定")
        sleep(2); shot("composer-text-keyboard"); sleep(3)
        frame("editor.typing", editor)
        dismissKeyboard()
        frame("editor.text", editor); frame("send", app.buttons["发送消息"])
        shot("composer-text"); sleep(3)
        mark("end")
    }

    // MARK: Scrolled thread (top edge over a bubble / code block, 到底部 pill)

    /// `AA_POC_SCROLL_UP` does not stick while the demo streams (the renderer follows the end again on the next content
    /// change unless a touch detached it), so this waits for the demo to finish and then scrolls with real drags:
    /// `AA_REF_STEPS` drags of `AA_REF_STEP` points each (slow, held at the end so there is no momentum), with a
    /// screenshot `scroll-<i>` after every drag. `AA_REF_SETTLE` seconds to wait first (default 35).
    func testRefScroll() throws {
        let env = ProcessInfo.processInfo.environment
        let step = Double(env["AA_REF_STEP"] ?? "") ?? 200
        let steps = Int(env["AA_REF_STEPS"] ?? "") ?? 10
        let settle = UInt32(env["AA_REF_SETTLE"] ?? "") ?? 35
        var extra = ["AA_POC_AUTO_APPROVE_SECONDS": "1"]
        if let log = env["AA_REF_APP_LOG"] { extra["AA_POC_LOG_PATH"] = log; extra["AA_POC_LAYOUT_CHECK"] = "1" }
        let app = launchApp(extra)
        XCTAssertTrue(app.buttons["打开侧栏"].waitForExistence(timeout: 30))
        sleep(settle)
        frame("window", app.windows.firstMatch)
        shot("scroll-0"); sleep(3)
        // `AA_REF_DRAGS=250,250,-30`: explicit drag list (positive = towards older content), overrides STEP/STEPS.
        let drags = (env["AA_REF_DRAGS"] ?? "").split(separator: ",").compactMap { Double($0) }
        let list = drags.isEmpty ? Array(repeating: step, count: steps) : drags
        for (index, distance) in list.enumerated() {
            let i = index + 1
            let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: distance > 0 ? 0.25 : 0.55))
            mark("scroll.\(i) \(distance)")
            from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 0, dy: distance)), withVelocity: .slow,
                       thenHoldForDuration: 0.5)
            sleep(2)
            shot("scroll-\(i)"); sleep(3)
        }
        let pill = app.buttons["滚动到底部"]
        if pill.exists { frame("pill", pill) }
        mark("end")
    }

    // MARK: 到底部 pill

    func testRefPill() throws {
        let env = ProcessInfo.processInfo.environment
        let drag = Double(env["AA_REF_STEP"] ?? "") ?? 400
        let app = launchApp(["AA_POC_AUTO_APPROVE_SECONDS": "1"])
        XCTAssertTrue(app.buttons["打开侧栏"].waitForExistence(timeout: 30))
        sleep(UInt32(env["AA_REF_SETTLE"] ?? "") ?? 35) // the demo finishes; the composer shows the idle send button
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
        mark("scroll")
        from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 0, dy: drag)), withVelocity: .slow,
                   thenHoldForDuration: 0.5)
        let pill = app.buttons["滚动到底部"]
        XCTAssertTrue(pill.waitForExistence(timeout: 10))
        sleep(2)
        frame("pill", pill)
        shot("pill-rest"); sleep(3)
        pressAndCancel("pill.cancel", pill, dragBy: CGVector(dx: 0, dy: -120)); sleep(2)
        pressAndCancel("pill.left", pill, dx: 0.15, hold: 1.5, dragBy: CGVector(dx: 0, dy: -120)); sleep(2)
        pressAndCancel("pill.right", pill, dx: 0.85, hold: 1.5, dragBy: CGVector(dx: 0, dy: -120)); sleep(2)
        pressAndCancel("pill.held", pill, hold: 3.0, dragBy: CGVector(dx: 0, dy: -120), shotDuringHold: "press-pill-held"); sleep(3)
        pressAndRelease("pill.press", pill); sleep(3)
        mark("end")
    }

    // MARK: System switch (Settings)

    /// Settings → General → Keyboard; the first switch there (restored to its starting value at the end).
    func testRefSwitch() throws {
        let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        settings.terminate()
        settings.launch()
        sleep(3)
        func open(_ names: [String]) -> Bool {
            for name in names {
                let cell = settings.cells.containing(.staticText, identifier: name).firstMatch
                let text = settings.staticTexts[name].firstMatch
                for _ in 0 ..< 6 {
                    if text.exists, text.isHittable { text.tap(); sleep(2); return true }
                    if cell.exists, cell.isHittable { cell.tap(); sleep(2); return true }
                    settings.swipeUp(); sleep(1)
                }
            }
            return false
        }
        let dump = (marksPath as NSString).deletingLastPathComponent + "/settings-tree.txt"
        guard open(["通用", "General"]), open(["键盘", "Keyboard", "Keyboards"]) else {
            try? settings.debugDescription.write(toFile: dump, atomically: true, encoding: .utf8)
            XCTFail("could not reach the keyboard settings; tree in \(dump)"); return
        }
        try? settings.debugDescription.write(toFile: dump, atomically: true, encoding: .utf8)
        let toggle = settings.switches.element(boundBy: 0)
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        let initial = toggle.value as? String ?? "?"
        write("info switch \(toggle.label.replacingOccurrences(of: " ", with: "_")) initial=\(initial)")
        frame("switch", toggle)
        frame("window", settings.windows.firstMatch)
        sleep(2)
        let isOn = { (toggle.value as? String) == "1" }
        // The switch element spans the whole cell; the control itself is the 62x28 pt track at the trailing end.
        let f = toggle.frame
        func onTrack(_ x: CGFloat) -> XCUICoordinate { // x: points from the track's leading edge (0…62)
            toggle.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: f.width - 62 + x, dy: f.height / 2))
        }
        let center = onTrack(31), offKnob = onTrack(16), onKnob = onTrack(46)
        func tapSwitch() { center.tap() }
        // Make it off first.
        if isOn() { tapSwitch(); sleep(2) }
        shot("switch-off"); sleep(3)
        // Hold (no movement) while off: the knob grows into the lens.
        mark("switch.held-off.down"); shot("switch-held-off", after: 1.2)
        offKnob.press(forDuration: 2.5) // lifting in place toggles it on
        mark("switch.held-off.up"); sleep(3)
        shot("switch-on"); sleep(3)
        mark("switch.held-on.down"); shot("switch-held-on", after: 1.2)
        onKnob.press(forDuration: 2.5) // → off
        mark("switch.held-on.up"); sleep(3)
        if isOn() { tapSwitch(); sleep(2) }
        // Drag the knob from off to on and hold at the far end.
        mark("switch.drag.down"); shot("switch-dragging", after: 1.6)
        offKnob.press(forDuration: 0.6, thenDragTo: onKnob, withVelocity: .slow, thenHoldForDuration: 2.0)
        mark("switch.drag.up"); sleep(3)
        // Half-way drag, held.
        if isOn() { tapSwitch(); sleep(2) }
        mark("switch.drag-mid.down"); shot("switch-dragging-mid", after: 1.4)
        offKnob.press(forDuration: 0.6, thenDragTo: center, withVelocity: .slow, thenHoldForDuration: 2.0)
        mark("switch.drag-mid.up"); sleep(3)
        // Plain taps for the toggle animation.
        if isOn() { tapSwitch(); sleep(2) }
        mark("switch.tap-on"); tapSwitch(); sleep(3)
        mark("switch.tap-off"); tapSwitch(); sleep(3)
        mark("switch.tap-on2"); tapSwitch(); sleep(3)
        mark("switch.tap-off2"); tapSwitch(); sleep(3)
        // Restore.
        if (initial == "1") != isOn() { tapSwitch(); sleep(2) }
        write("info switch restored=\(toggle.value as? String ?? "?")")
        mark("end")
        settings.terminate()
    }
}
