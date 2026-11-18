import XCTest

/// Mouse wheel / trackpad scrolling (pointer scroll events, not touches) over the thread.
///
/// XCUITest can only send pointer events to a device that supports a pointer: run this on an iPad simulator (on an
/// iPhone it fails with "Pointer events are not supported for this device"; the iPhone Simulator itself also drops
/// the Mac's scroll wheel, see README). With `AA_POC_LAYOUT_CHECK=1` the app logs to `AA_POC_LOG_PATH` the thread's
/// offset (`[scroll] y=…`), the 到底部 pill (`[pill] shown=…`), `loadOlder` requests (`[older]`), and from inside the
/// page every `wheel` event (`[wheel]`) and sideways scrolling of code blocks and tables (`[hscroll]`).
final class WheelScrollTests: XCTestCase {
    private var log = ""

    private func mark(_ text: String) {
        let fd = open(log, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        guard fd >= 0 else { return }
        let line = "[test] \(text)\n"
        _ = line.withCString { write(fd, $0, strlen($0)) }
        close(fd)
    }

    /// Log lines between two `[test]` marks.
    private func lines(after start: String, before end: String? = nil) -> [String] {
        let all = ((try? String(contentsOfFile: log, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
        guard let from = all.firstIndex(of: "[test] \(start)") else { return [] }
        let rest = all[(from + 1)...]
        let to = end.flatMap { rest.firstIndex(of: "[test] \($0)") } ?? rest.endIndex
        return Array(rest[..<to])
    }

    private func skipOnPhone() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .phone,
                      "XCUITest cannot send pointer scroll events to an iPhone; run on an iPad simulator")
    }

    private func offsets(_ lines: [String]) -> [Double] {
        lines.compactMap { line in
            guard let range = line.range(of: "[scroll] y=") else { return nil }
            return Double(line[range.upperBound...].prefix { $0 == "-" || $0.isNumber })
        }
    }

    func testWheelScrollsThread() throws {
        try skipOnPhone()
        let env = ProcessInfo.processInfo.environment
        log = env["AA_POC_WHEEL_LOG"] ?? "/tmp/aav3poc-wheel.log"
        try? FileManager.default.removeItem(atPath: log)
        let app = XCUIApplication()
        app.launchEnvironment["AA_POC_SCHEME"] = "light"
        app.launchEnvironment["AA_POC_LAYOUT_CHECK"] = "1"
        app.launchEnvironment["AA_POC_LOG_PATH"] = log
        // A session longer than the cache keeps (300 items), short enough to wheel to its top: `loadOlder` must fire.
        app.launchEnvironment["AA_POC_STRESS"] = env["AA_POC_STRESS"] ?? "snapshot:320,items:0,chars:120,lines:6,difflines:4,approve:0"
        app.launch()
        sleep(6)
        let thread = app.coordinate(withNormalizedOffset: CGVector(dx: 0.62, dy: 0.45))

        // XCUITest's deltaY follows the wheel: negative moves the document down, i.e. towards older content.
        mark("wheel up")
        for _ in 0 ..< 6 { thread.scroll(byDeltaX: 0, deltaY: -400); usleep(150_000) }
        sleep(2)
        mark("wheel down")
        for _ in 0 ..< 3 { thread.scroll(byDeltaX: 0, deltaY: 400); usleep(150_000) }
        sleep(2)
        mark("wheel to top")
        for _ in 0 ..< 60 {
            thread.scroll(byDeltaX: 0, deltaY: -2000)
            if lines(after: "wheel to top").contains(where: { $0.contains("[older]") }) { break }
        }
        sleep(2)
        mark("touch drag")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.62, dy: 0.7)).press(forDuration: 0.02, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.62, dy: 0.3)))
        sleep(2)
        mark("done")
        XCTAssertEqual(app.state, .runningForeground)
        app.terminate()

        let up = offsets(lines(after: "wheel up", before: "wheel down"))
        let down = offsets(lines(after: "wheel down", before: "wheel to top"))
        let all = lines(after: "wheel up", before: "done")
        print("wheel up offsets: \(up)\nwheel down offsets: \(down)")
        print(all.filter { $0.contains("[pill]") || $0.contains("[older]") || $0.contains("[hscroll]") || $0.contains("[wheel]") }.prefix(40).joined(separator: "\n"))
        XCTAssertGreaterThan((up.first ?? 0) - (up.min() ?? 0), 300, "the wheel did not scroll the thread up")
        XCTAssertGreaterThan((down.max() ?? 0) - (down.first ?? 0), 150, "the wheel did not scroll the thread down")
        XCTAssertTrue(lines(after: "wheel up", before: "wheel to top").contains { $0.contains("[pill] shown=1") }, "到底部 did not appear")
        XCTAssertTrue(lines(after: "wheel up", before: "touch drag").contains { $0.contains("[older]") }, "no loadOlder")
        let drag = offsets(lines(after: "touch drag", before: "done"))
        XCTAssertGreaterThan((drag.max() ?? 0) - (drag.min() ?? 0), 100, "a touch drag no longer scrolls")
    }

    /// Sideways wheel / two-finger swipe over the demo session's code block and table (`s-unread`, which has both):
    /// walk up the thread and swipe sideways at several heights until a sideways scroller moves.
    func testWheelScrollsCodeAndTableSideways() throws {
        try skipOnPhone()
        let env = ProcessInfo.processInfo.environment
        log = env["AA_POC_WHEEL_LOG"].map { $0 + ".x" } ?? "/tmp/aav3poc-wheel-x.log"
        try? FileManager.default.removeItem(atPath: log)
        let app = XCUIApplication()
        app.launchEnvironment["AA_POC_SCHEME"] = "light"
        app.launchEnvironment["AA_POC_LAYOUT_CHECK"] = "1"
        app.launchEnvironment["AA_POC_LOG_PATH"] = log
        app.launchEnvironment["AA_POC_SESSION"] = "s-unread"
        app.launchEnvironment["AA_POC_AUTO_APPROVE_SECONDS"] = "1"
        app.launch()
        sleep(25) // the demo turn streams and finishes
        mark("sideways")
        var found = false
        for _ in 0 ..< 30 where !found {
            for y in stride(from: 0.2, through: 0.75, by: 0.08) {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.62, dy: y)).scroll(byDeltaX: 240, deltaY: 0)
            }
            found = lines(after: "sideways").contains { $0.contains("[hscroll]") }
            if !found { app.coordinate(withNormalizedOffset: CGVector(dx: 0.62, dy: 0.45)).scroll(byDeltaX: 0, deltaY: -250) }
        }
        mark("touch drag")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.62, dy: 0.3)).press(forDuration: 0.02, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.62, dy: 0.7)))
        sleep(2)
        mark("done")
        XCTAssertEqual(app.state, .runningForeground)
        app.terminate()
        print(lines(after: "sideways", before: "touch drag").filter { $0.contains("[hscroll]") }.prefix(10).joined(separator: "\n"))
        XCTAssertTrue(found, "no code block or table scrolled sideways")
        let drag = offsets(lines(after: "touch drag", before: "done"))
        XCTAssertGreaterThan((drag.max() ?? 0) - (drag.min() ?? 0), 100, "a touch drag no longer scrolls")
    }
}
