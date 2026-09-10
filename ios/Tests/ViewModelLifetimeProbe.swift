import SwiftUI
import AppKit
import Observation

// A real SwiftUI identity/update check with no window, app, simulator or network.
// Compile alongside Views/Components/StableViewModel.swift.
@MainActor private final class Measurements {
    var created = 0
    var bodies = 0
    var tasks = 0
    var displayedValue = -1
    weak var model: ProbeModel?
}

@MainActor @Observable private final class ProbeModel {
    var value = 0
    init(_ measurements: Measurements) {
        measurements.created += 1
        measurements.model = self
    }
}

@MainActor @Observable private final class Driver {
    var pulse = 0
    var identity = 0
}

private struct LazyPage: View, Equatable {
    let measurements: Measurements
    @StateObject private var storage: StableViewModel<ProbeModel>
    init(_ measurements: Measurements) {
        self.measurements = measurements
        _storage = StateObject(wrappedValue: StableViewModel { ProbeModel(measurements) })
    }
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.measurements === rhs.measurements }
    var body: some View {
        let _ = { measurements.bodies += 1; measurements.displayedValue = storage.value.value }()
        Text("\(storage.value.value)")
            .task { measurements.tasks += 1 }
    }
}

private struct EagerPage: View, Equatable {
    let measurements: Measurements
    @State private var model: ProbeModel
    init(_ measurements: Measurements) {
        self.measurements = measurements
        _model = State(initialValue: ProbeModel(measurements))
    }
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.measurements === rhs.measurements }
    var body: some View { Text("\(model.value)") }
}

private struct Root: View {
    let driver: Driver
    let lazy: Measurements
    let eager: Measurements
    var body: some View {
        VStack {
            Text("\(driver.pulse)")
            LazyPage(lazy).equatable().id(driver.identity)
            EagerPage(eager).equatable().id(driver.identity)
        }
    }
}

@main @MainActor private struct ViewModelLifetimeProbe {
    static func main() {
        let driver = Driver(), lazy = Measurements(), eager = Measurements()
        let host = NSHostingView(rootView: Root(driver: driver, lazy: lazy, eager: eager))
        host.frame = CGRect(x: 0, y: 0, width: 402, height: 240)
        func update() {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.005))
            host.layoutSubtreeIfNeeded()
        }
        update()
        let taskCount = lazy.tasks
        precondition(taskCount > 0, "The probe did not start the page task")
        for pulse in 1...120 { driver.pulse = pulse; update() }
        precondition(eager.created >= 120, "Positive control did not reconstruct its eager model")
        precondition(lazy.created == 1, "Unchanged view identity recreated its model")
        precondition(lazy.tasks == taskCount, "Parent refresh restarted the page task")
        print("PASS: 120 parent updates; eager model creations \(eager.created), lazy model creations \(lazy.created), task restarts \(lazy.tasks - taskCount).")
        lazy.model?.value = 42
        update()
        precondition(lazy.displayedValue == 42, "Observable model updates did not reach the page")
        driver.identity += 1
        update()
        precondition(lazy.created == 2 && lazy.displayedValue == 0, "A new page identity did not create a fresh model")
        print("PASS: model observation remains live, and changing the page identity creates a fresh model.")
    }
}
