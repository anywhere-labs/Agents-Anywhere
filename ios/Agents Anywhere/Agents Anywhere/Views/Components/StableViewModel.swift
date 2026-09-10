import Combine

/// StateObject supplies a lazy factory tied to view identity. The model itself
/// can use Observation; this holder only owns its lifetime. State(initialValue:)
/// would eagerly build and discard another model whenever the parent rebuilds.
@MainActor final class StableViewModel<Model>: ObservableObject {
    let value: Model

    init(_ makeValue: () -> Model) {
        value = makeValue()
    }
}
