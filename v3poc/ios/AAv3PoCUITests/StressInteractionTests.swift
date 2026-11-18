import XCTest

/// Drives a stress run (`AA_POC_STRESS`) like a reader would while the session keeps streaming: scrolls up to read, holds
/// (does the thread pull back to the end?), taps the native 到底部 pill, flings up and down, opens and closes the drawer.
/// Every action is written with a wall-clock time to `<AA_POC_LOG_PATH>.test.log`, so the summary can line them up with
/// the app's `[stress]` lines. Started by `v3poc/ios/stress/run.sh --interact`; environment comes in as TEST_RUNNER_*.
final class StressInteractionTests: XCTestCase {
    private let env = ProcessInfo.processInfo.environment
    private var logPath: String { env["AA_POC_LOG_PATH"] ?? NSTemporaryDirectory() + "aav3poc-stress.log" }

    private func mark(_ what: String) {
        let line = String(format: "{\"wall\":%.1f,\"action\":\"%@\"}\n", Date().timeIntervalSince1970, what)
        let path = logPath + ".test.log"
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close()
        } else {
            FileManager.default.createFile(atPath: path, contents: Data(line.utf8))
        }
    }

    private func pill() -> CGVector? {
        guard let data = FileManager.default.contents(atPath: logPath + ".ui.json"),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let point = object["pill"] as? [Double], point.count == 2 else { return nil }
        return CGVector(dx: point[0], dy: point[1])
    }

    func testStressWhileReading() throws {
        continueAfterFailure = true
        let app = XCUIApplication()
        for key in ["AA_POC_STRESS", "AA_POC_LOG_PATH", "AA_POC_AUTO_APPROVE_SECONDS", "AA_POC_SWITCH", "AA_POC_SCHEME", "AA_POC_RENDERER_PATH", "AA_POC_MEMORY_WARNING", "AA_POC_CACHE_ITEMS"] {
            if let value = env[key] { app.launchEnvironment[key] = value }
        }
        let seconds = Double(env["AA_POC_STRESS_SECONDS"] ?? "") ?? 240
        let start = Date()
        mark("launch")
        app.launch()
        mark("launched")
        func at(_ x: CGFloat, _ y: CGFloat) -> XCUICoordinate { app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)) }
        func wait(until second: Double) {
            let remaining = second - Date().timeIntervalSince(start)
            if remaining > 0 { Thread.sleep(forTimeInterval: remaining) }
        }

        var cycle = 0.0
        while Date().timeIntervalSince(start) < seconds - 60 {
            wait(until: cycle + 20)
            mark("read: scroll up")
            for _ in 0 ..< 3 { at(0.5, 0.35).press(forDuration: 0.05, thenDragTo: at(0.5, 0.75)) }
            mark("read: hold 10 s")
            Thread.sleep(forTimeInterval: 10)
            mark("read: hold end")
            if let pill = pill() {
                mark("pill: tap")
                app.coordinate(withNormalizedOffset: pill).tap()
                mark("pill: tapped")
            } else {
                mark("pill: not shown")
            }
            wait(until: cycle + 40)
            mark("fling")
            // Explicit mid-screen flings: `swipeUp()` starts low enough that a late, lagging synthesized drag can be read
            // as the home-indicator gesture (app switcher), which ended one baseline run early.
            for (from, to) in [(0.3, 0.7), (0.7, 0.3), (0.3, 0.7), (0.7, 0.3)] {
                at(0.5, from).press(forDuration: 0.01, thenDragTo: at(0.5, to), withVelocity: .fast, thenHoldForDuration: 0)
            }
            mark("fling end")
            wait(until: cycle + 50)
            mark("drawer: open")
            at(0.01, 0.5).press(forDuration: 0.05, thenDragTo: at(0.8, 0.5))
            Thread.sleep(forTimeInterval: 2)
            mark("drawer: close")
            at(0.92, 0.5).tap()
            mark("drawer: closed")
            cycle += 60
            XCTAssertEqual(app.state, .runningForeground, "app stopped during cycle \(Int(cycle / 60))")
            if app.state != .runningForeground { return }
        }
        wait(until: seconds)
        mark("end")
        XCTAssertEqual(app.state, .runningForeground)
    }
}
