import XCTest

/// Gesture stress over the WKWebView thread with the native drawer on top: reproduces the crash in
/// `-[UIGestureRecognizer _delayTouchesForEvent:inPhase:]` (nil touch inserted) seen while trying the PoC by hand.
/// Run on a spare simulator: it drives the screen for a couple of minutes.
final class GestureStressTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testThreadAndDrawerGesturesDoNotCrash() throws {
        let app = XCUIApplication()
        app.launchEnvironment["AA_POC_SCHEME"] = "light"
        for key in ["AA_POC_RENDERER_PATH"] { // passed through as TEST_RUNNER_AA_POC_RENDERER_PATH
            if let value = ProcessInfo.processInfo.environment[key] { app.launchEnvironment[key] = value }
        }
        app.launchEnvironment["AA_POC_DEMO"] = "1"
        app.launch()
        sleep(4) // renderer ready, script streaming

        let rounds = Int(ProcessInfo.processInfo.environment["AA_POC_STRESS_ROUNDS"] ?? "") ?? 12
        func at(_ x: CGFloat, _ y: CGFloat) -> XCUICoordinate {
            app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y))
        }
        let actions: [(String, () -> Void)] = [
            ("edge drag opens drawer", { at(0.01, 0.5).press(forDuration: 0.05, thenDragTo: at(0.8, 0.5)) }),
            ("tap content strip closes drawer", { at(0.92, 0.5).tap() }),
            ("long press on text", { at(0.4, 0.45).press(forDuration: 1.2) }),
            ("press and drag selects text", { at(0.3, 0.4).press(forDuration: 0.8, thenDragTo: at(0.7, 0.55)) }),
            ("fast swipe up", { app.swipeUp(velocity: .fast) }),
            ("fast swipe down", { app.swipeDown(velocity: .fast) }),
            ("horizontal drag mid-thread right", { at(0.3, 0.5).press(forDuration: 0.02, thenDragTo: at(0.95, 0.52)) }),
            ("horizontal drag mid-thread left", { at(0.8, 0.5).press(forDuration: 0.02, thenDragTo: at(0.1, 0.48)) }),
            ("double tap", { at(0.5, 0.5).doubleTap() }),
            ("tap thread", { at(0.5, 0.6).tap() }),
            ("edge drag then immediate tap", {
                at(0.01, 0.4).press(forDuration: 0.02, thenDragTo: at(0.5, 0.4))
                at(0.5, 0.5).tap()
            }),
            ("tap content strip closes drawer (again)", { at(0.92, 0.5).tap() }),
            ("long press then swipe", {
                at(0.5, 0.35).press(forDuration: 0.9)
                app.swipeUp(velocity: .default)
            }),
        ]
        let only = ProcessInfo.processInfo.environment["AA_POC_ONLY"].flatMap(Int.init)
        let selected = only.map { [actions[$0]] } ?? actions
        for round in 0 ..< (only == nil ? rounds : 4) {
            for (name, action) in selected {
                action()
                if app.state != .runningForeground {
                    XCTFail("App stopped after round \(round) action \(name)")
                    return
                }
            }
        }
    }

    /// As the user hit it: a cold start, then taps, long presses and drags on the thread right away, repeated with
    /// fresh processes (`AA_POC_COLD_CYCLES`, default 12). Each cycle runs ~10 s from launch.
    func testColdStartTouches() throws {
        let cycles = Int(ProcessInfo.processInfo.environment["AA_POC_COLD_CYCLES"] ?? "") ?? 12
        for cycle in 0 ..< cycles {
            let app = XCUIApplication()
            app.launchEnvironment["AA_POC_SCHEME"] = "light"
            if let path = ProcessInfo.processInfo.environment["AA_POC_RENDERER_PATH"] { app.launchEnvironment["AA_POC_RENDERER_PATH"] = path }
            app.launchEnvironment["AA_POC_DEMO"] = "1"
            app.launch()
            func at(_ x: CGFloat, _ y: CGFloat) -> XCUICoordinate { app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)) }
            let start = Date()
            var step = 0
            while Date().timeIntervalSince(start) < 10 {
                switch step % 6 {
                case 0: at(0.5, 0.45).tap()
                case 1: at(0.5, 0.35).press(forDuration: 0.6)
                case 2: at(0.5, 0.3).press(forDuration: 0.01, thenDragTo: at(0.5, 0.7), withVelocity: .fast, thenHoldForDuration: 0)
                case 3: at(0.8, 0.5).press(forDuration: 0.02, thenDragTo: at(0.2, 0.5))
                case 4: at(0.4, 0.55).doubleTap()
                default: at(0.5, 0.7).press(forDuration: 0.01, thenDragTo: at(0.5, 0.3), withVelocity: .fast, thenHoldForDuration: 0)
                }
                step += 1
                if app.state != .runningForeground {
                    XCTFail("app stopped in cold-start cycle \(cycle) after \(step) actions (\(Int(Date().timeIntervalSince(start))) s)")
                    return
                }
            }
            app.terminate()
        }
    }
}
