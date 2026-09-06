import Foundation

/// Only explicit protocol translation keys are looked up. Agent/user prose,
/// model names, paths and opaque action/selection IDs remain unchanged.
enum RuntimeLocalizedCopy {
    static func text(_ fallback: String, metadata: JSONValue, field: String = "labelKey", locale: Locale = .current, bundle: Bundle = .main) -> String {
        guard let key = metadata["i18n"]?[field]?.stringValue else { return fallback }
        let translated = String(localized: String.LocalizationValue(key), bundle: bundle, locale: locale)
        return translated == key ? fallback : translated
    }
}

extension V2DeviceRuntimeStatus {
    var displayName: String {
        switch self {
        case .stopped: String(localized: "Stopped")
        case .discovering: String(localized: "Discovering…")
        case .available: String(localized: "Available")
        case .unavailable: String(localized: "Unavailable")
        case .validating: String(localized: "Validating…")
        case .starting: String(localized: "Starting…")
        case .running: String(localized: "Running")
        case .stopping: String(localized: "Stopping…")
        case .error: String(localized: "Error")
        case .unknown: String(localized: "Unknown")
        }
    }
}

extension V2RuntimeStatus {
    var displayName: String {
        switch self {
        case .idle: String(localized: "Idle")
        case .waiting: String(localized: "Waiting")
        case .waitingApproval: String(localized: "Waiting for approval")
        case .pending: String(localized: "Pending")
        case .running: String(localized: "Running")
        case .stopping: String(localized: "Stopping…")
        case .blocked: String(localized: "Blocked")
        case .error: String(localized: "Error")
        case .disconnected: String(localized: "Disconnected")
        case .unknown: String(localized: "Unknown")
        }
    }
}
