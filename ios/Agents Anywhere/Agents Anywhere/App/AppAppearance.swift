import SwiftUI

enum AppAppearance: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    static let storageKey = "agentsAnywhere.appearance"

    var id: String { rawValue }

    var title: LocalizedStringResource {
        switch self {
        case .system:
            "System"
        case .light:
            "Light"
        case .dark:
            "Dark"
        }
    }

    var description: LocalizedStringResource {
        switch self {
        case .system:
            "Match the device appearance."
        case .light:
            "Always use the light appearance."
        case .dark:
            "Always use the dark appearance."
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system:
            nil
        case .light:
            .light
        case .dark:
            .dark
        }
    }
}
