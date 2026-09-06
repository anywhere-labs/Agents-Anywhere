import Foundation
import Observation

/// Editors bind to each row, never to an index in the parent's mutable array.
/// A field can finish an edit after deletion or reset without accessing another
/// row or writing the removed row back into the configuration.
@MainActor @Observable
final class RuntimeEnvironmentRow: Identifiable {
    let id = UUID()
    var key: String
    var value: String
    var removesInherited: Bool

    init(key: String = "", value: String = "", removesInherited: Bool = false) {
        self.key = key
        self.value = value
        self.removesInherited = removesInherited
    }
}

@MainActor @Observable
final class RuntimeEffortRow: Identifiable {
    let id = UUID()
    var effortID: String
    var displayName: String

    init(effortID: String = "", displayName: String = "") {
        self.effortID = effortID
        self.displayName = displayName
    }
}

@MainActor @Observable
final class RuntimeCustomModelRow: Identifiable {
    let id = UUID()
    var modelID: String
    var displayName: String
    var efforts: [RuntimeEffortRow]

    init(modelID: String = "", displayName: String = "", efforts: [RuntimeEffortRow] = []) {
        self.modelID = modelID
        self.displayName = displayName
        self.efforts = efforts
    }

    func removeEffort(_ id: UUID) {
        efforts.removeAll { $0.id == id }
    }
}
