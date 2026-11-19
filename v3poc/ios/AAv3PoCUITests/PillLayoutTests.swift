import XCTest

/// The 到底部 pill must stay 6 pt above the bottom bar while the thread streams: scroll up (pill appears), back to the
/// end (pill goes), with the approval dock coming and going and the keyboard up or down. The app logs every chrome
/// layout with the pill to `AA_POC_LOG_PATH` (`[layout] … ok|OVERLAP`, `AA_POC_LAYOUT_CHECK=1`); this test drives the
/// states and fails on any OVERLAP line.
final class PillLayoutTests: XCTestCase {
    func testPillStaysAboveBar() throws {
        let env = ProcessInfo.processInfo.environment
        let log = env["AA_POC_PILL_LOG"] ?? "/tmp/aav3poc-pill-layout.log"
        try? FileManager.default.removeItem(atPath: log)
        let app = XCUIApplication()
        app.launchEnvironment["AA_POC_SCHEME"] = "light"
        app.launchEnvironment["AA_POC_STRESS"] = env["AA_POC_STRESS"] ?? "snapshot:40,hz:10,parallel:2,lines:200,difflines:40,chars:2500,approve:4"
        app.launchEnvironment["AA_POC_AUTO_APPROVE_SECONDS"] = "4"
        app.launchEnvironment["AA_POC_LAYOUT_CHECK"] = "1"
        app.launchEnvironment["AA_POC_LOG_PATH"] = log
        app.launch()
        sleep(5)
        func at(_ x: CGFloat, _ y: CGFloat) -> XCUICoordinate { app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)) }
        let pill = app.buttons["滚动到底部"]
        let rounds = Int(env["AA_POC_PILL_ROUNDS"] ?? "") ?? 12
        for round in 0 ..< rounds {
            for _ in 0 ..< 3 { at(0.5, 0.3).press(forDuration: 0.02, thenDragTo: at(0.5, 0.7)) } // towards older content
            sleep(1)
            if round % 3 == 1 {
                // Keyboard up while the pill shows (a drag on the thread would dismiss it again).
                app.textViews.firstMatch.tap()
                sleep(2)
            }
            if pill.waitForExistence(timeout: 3) { pill.tap() } else { at(0.5, 0.6).tap() }
            sleep(2)
            if round % 3 == 1 { at(0.5, 0.45).press(forDuration: 0.02, thenDragTo: at(0.5, 0.55)) } // dismisses the keyboard
            XCTAssertEqual(app.state, .runningForeground)
        }
        app.terminate()
        let lines = ((try? String(contentsOfFile: log, encoding: .utf8)) ?? "").split(separator: "\n").filter { $0.contains("[layout]") }
        let overlaps = lines.filter { $0.contains("OVERLAP") }
        print("pill layout checks: \(lines.count), dock: \(lines.filter { $0.contains("dock=1") }.count), keyboard: \(lines.filter { $0.contains("keyboard=1") }.count), overlaps: \(overlaps.count)")
        XCTAssertGreaterThan(lines.count, 0, "the pill never appeared")
        XCTAssertTrue(overlaps.isEmpty, overlaps.prefix(5).joined(separator: "\n"))
    }
}
