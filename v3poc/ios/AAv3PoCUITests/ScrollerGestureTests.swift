import XCTest

/// Scrollable regions inside the page (wide tables, long code lines) are separate UIScrollViews that WebKit creates and
/// destroys on demand (`WKChildScrollView`). This drives them while new ones keep appearing: the stress session streams
/// tables and code blocks, the test drags horizontally, long-presses and drags, and taps at many heights, then switches to
/// another session and back (`AA_POC_SWITCH`) and does it again. Guards against the nil-touch abort in
/// `-[UIGestureRecognizer _delayTouchesForEvent:inPhase:]`.
final class ScrollerGestureTests: XCTestCase {
    func testHorizontalScrollersWhileStreaming() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        let env = ProcessInfo.processInfo.environment
        app.launchEnvironment["AA_POC_SCHEME"] = "light"
        app.launchEnvironment["AA_POC_STRESS"] = env["AA_POC_STRESS"] ?? "snapshot:40,hz:10,parallel:2,lines:300,difflines:60,chars:2500"
        app.launchEnvironment["AA_POC_AUTO_APPROVE_SECONDS"] = "1"
        app.launchEnvironment["AA_POC_SWITCH"] = env["AA_POC_SWITCH"] ?? "s-unread@45,s-stress@60"
        for key in ["AA_POC_RENDERER_PATH", "AA_POC_LOG_PATH"] {
            if let value = env[key] { app.launchEnvironment[key] = value }
        }
        app.launchEnvironment["AA_POC_DEMO"] = "1"
        app.launch()
        sleep(4)
        func at(_ x: CGFloat, _ y: CGFloat) -> XCUICoordinate { app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)) }
        let start = Date()
        let seconds = Double(env["AA_POC_SCROLLER_SECONDS"] ?? "") ?? 100
        var round = 0
        while Date().timeIntervalSince(start) < seconds {
            for y in stride(from: 0.2, through: 0.75, by: 0.11) {
                at(0.85, y).press(forDuration: 0.02, thenDragTo: at(0.15, y + 0.01))          // table / code to the left
                at(0.2, y).press(forDuration: 0.02, thenDragTo: at(0.75, y))                  // and back
                at(0.5, y).press(forDuration: 0.7, thenDragTo: at(0.6, y + 0.08))             // long press, then drag
                at(0.5, y + 0.03).tap()
                XCTAssertEqual(app.state, .runningForeground, "stopped in round \(round) at y=\(y)")
            }
            at(0.5, 0.7).press(forDuration: 0.01, thenDragTo: at(0.5, 0.3), withVelocity: .fast, thenHoldForDuration: 0) // more content
            round += 1
        }
    }
}
