import SwiftUI

extension View {
    /// Shared finish cue for a reply and the New Session welcome presentation.
    func completionFeedback<Value: Equatable>(trigger: Value,
        condition: @escaping (Value, Value) -> Bool = { _, _ in true }) -> some View {
        modifier(CompletionFeedback(trigger: trigger, condition: condition))
    }
}

private struct CompletionFeedback<Value: Equatable>: ViewModifier {
    let trigger: Value
    let condition: (Value, Value) -> Bool
    @Environment(\.scenePhase) private var scenePhase
    @State private var pulse = 0
    @State private var playback: Task<Void, Never>?

    func body(content: Content) -> some View {
        content
            .sensoryFeedback(.impact(flexibility: .rigid, intensity: 0.65), trigger: pulse)
            .onChange(of: trigger) { previous, current in
                playback?.cancel()
                guard scenePhase == .active, condition(previous, current) else { return }
                playback = Task { @MainActor in
                    pulse += 1
                    do { try await Task.sleep(for: .milliseconds(120)) }
                    catch { return }
                    guard !Task.isCancelled, scenePhase == .active else { return }
                    pulse += 1
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { playback?.cancel() }
            }
            .onDisappear { playback?.cancel() }
    }
}
