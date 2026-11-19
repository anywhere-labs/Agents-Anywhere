import ObjectiveC
import XCTest

/// The user's reproduction of the `_delayTouchesForEvent:inPhase:` abort: fling the thread, and while it is still
/// scrolling by momentum touch it again (tap or drag) within 0.1–0.5 s. XCUITest normally waits for the app to be idle,
/// animations included, before every event, so its taps never land during momentum; this test switches that wait off
/// (private XCUIAutomation selectors, test runner only) to send the second touch in time.
final class MomentumTouchTests: XCTestCase {
    private static var quiescenceDisabled = false

    /// Replaces `-[XCUIApplicationProcess waitForQuiescenceIncludingAnimationsIdle:(usingActivity:)isPreEvent:]` with no-ops.
    private static func disableQuiescenceWait() {
        guard !quiescenceDisabled, let cls = NSClassFromString("XCUIApplicationProcess") else { return }
        quiescenceDisabled = true
        let noop2: @convention(block) (AnyObject, Bool, Bool) -> Void = { _, _, _ in }
        let noop3: @convention(block) (AnyObject, Bool, AnyObject?, Bool) -> Void = { _, _, _, _ in }
        if let m = class_getInstanceMethod(cls, NSSelectorFromString("waitForQuiescenceIncludingAnimationsIdle:isPreEvent:")) {
            method_setImplementation(m, imp_implementationWithBlock(noop2))
        }
        if let m = class_getInstanceMethod(cls, NSSelectorFromString("waitForQuiescenceIncludingAnimationsIdle:usingActivity:isPreEvent:")) {
            method_setImplementation(m, imp_implementationWithBlock(noop3))
        }
    }

    private func run(coldStart: Bool, launches: Int, flingsPerLaunch: Int) {
        Self.disableQuiescenceWait()
        let env = ProcessInfo.processInfo.environment
        var rng = SystemRandomNumberGenerator()
        for launch in 0 ..< launches {
            let app = XCUIApplication()
            app.launchEnvironment["AA_POC_SCHEME"] = "light"
            // A long session, streaming: momentum has room to run and the bridge keeps sending (as in the user's case).
            app.launchEnvironment["AA_POC_STRESS"] = env["AA_POC_STRESS"] ?? "snapshot:60,hz:10,parallel:2,lines:300,difflines:60,chars:2500"
            app.launchEnvironment["AA_POC_AUTO_APPROVE_SECONDS"] = "1"
            if let path = env["AA_POC_RENDERER_PATH"] { app.launchEnvironment["AA_POC_RENDERER_PATH"] = path }
            app.launchEnvironment["AA_POC_DEMO"] = "1"
            app.launch()
            Thread.sleep(forTimeInterval: coldStart ? 1.5 : 4)
            func at(_ x: CGFloat, _ y: CGFloat) -> XCUICoordinate { app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)) }
            for fling in 0 ..< flingsPerLaunch {
                let down = fling % 3 != 0 // mostly towards older content, where there is room
                at(0.5, down ? 0.3 : 0.75).press(forDuration: 0.01, thenDragTo: at(0.5, down ? 0.75 : 0.3),
                                                withVelocity: .init(4000), thenHoldForDuration: 0)
                Thread.sleep(forTimeInterval: Double.random(in: 0.1 ... 0.5, using: &rng))
                switch fling % 4 {
                case 0, 2: at(0.5, Double.random(in: 0.3 ... 0.7, using: &rng)).tap()
                case 1: at(0.5, 0.6).press(forDuration: 0.01, thenDragTo: at(0.5, 0.4), withVelocity: .fast, thenHoldForDuration: 0)
                default: at(0.8, 0.5).press(forDuration: 0.02, thenDragTo: at(0.2, 0.5))
                }
                if app.state != .runningForeground {
                    XCTFail("app stopped: launch \(launch), fling \(fling)")
                    return
                }
            }
            app.terminate()
        }
    }

    func testTouchDuringMomentum() {
        let env = ProcessInfo.processInfo.environment
        run(coldStart: false, launches: Int(env["AA_POC_MOMENTUM_LAUNCHES"] ?? "") ?? 2,
            flingsPerLaunch: Int(env["AA_POC_MOMENTUM_FLINGS"] ?? "") ?? 40)
    }

    /// One of each kind of touch, for counting (under lldb) which gesture recognizers take part in touches on the
    /// thread: flings with a touch during momentum, a horizontal drag, a long press (text selection), the drawer.
    func testGestureSample() {
        Self.disableQuiescenceWait()
        let app = XCUIApplication()
        app.launchEnvironment["AA_POC_SCHEME"] = "light"
        app.launchEnvironment["AA_POC_STRESS"] = "snapshot:60,hz:2,parallel:1,lines:300,difflines:60,chars:2500"
        app.launchEnvironment["AA_POC_AUTO_APPROVE_SECONDS"] = "1"
        app.launchEnvironment["AA_POC_DEMO"] = "1"
        app.launch()
        Thread.sleep(forTimeInterval: 6)
        func at(_ x: CGFloat, _ y: CGFloat) -> XCUICoordinate { app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)) }
        for fling in 0 ..< 4 {
            at(0.5, 0.3).press(forDuration: 0.01, thenDragTo: at(0.5, 0.75), withVelocity: .init(4000), thenHoldForDuration: 0)
            Thread.sleep(forTimeInterval: 0.25)
            if fling % 2 == 0 { at(0.5, 0.5).tap() } else {
                at(0.5, 0.6).press(forDuration: 0.01, thenDragTo: at(0.5, 0.4), withVelocity: .fast, thenHoldForDuration: 0)
            }
        }
        Thread.sleep(forTimeInterval: 1)
        at(0.8, 0.5).press(forDuration: 0.02, thenDragTo: at(0.2, 0.5))
        Thread.sleep(forTimeInterval: 1)
        at(0.4, 0.45).press(forDuration: 1.2)
        Thread.sleep(forTimeInterval: 1)
        at(0.5, 0.3).tap()
        Thread.sleep(forTimeInterval: 1)
        at(0.015, 0.5).press(forDuration: 0.05, thenDragTo: at(0.75, 0.5))
        Thread.sleep(forTimeInterval: 1.5)
        at(0.9, 0.5).tap()
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertEqual(app.state, .runningForeground)
        app.terminate()
    }

    func testTouchDuringMomentumRightAfterColdStart() {
        let env = ProcessInfo.processInfo.environment
        run(coldStart: true, launches: Int(env["AA_POC_MOMENTUM_LAUNCHES"] ?? "") ?? 8,
            flingsPerLaunch: Int(env["AA_POC_MOMENTUM_COLD_FLINGS"] ?? "") ?? 8)
    }
}
