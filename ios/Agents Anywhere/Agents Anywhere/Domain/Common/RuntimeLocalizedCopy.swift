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
        case .stopped: String(localized: "dashboard.device.runtimeStatus.stopped")
        case .discovering: String(localized: "dashboard.device.runtimeStatus.discovering")
        case .available: String(localized: "dashboard.device.runtimeStatus.available")
        case .unavailable: String(localized: "dashboard.device.runtimeStatus.unavailable")
        case .validating: String(localized: "dashboard.device.runtimeStatus.validating")
        case .starting: String(localized: "dashboard.device.runtimeStatus.starting")
        case .running: String(localized: "dashboard.device.runtimeStatus.running")
        case .stopping: String(localized: "dashboard.device.runtimeStatus.stopping")
        case .error: String(localized: "dashboard.device.runtimeStatus.error")
        case .unknown: String(localized: "dashboard.device.runtimeStatus.unknown")
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
