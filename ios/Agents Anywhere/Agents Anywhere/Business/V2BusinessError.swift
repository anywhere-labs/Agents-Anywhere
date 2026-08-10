import Foundation

enum V2BusinessError: LocalizedError {
    case emptyMessage
    case emptySessionSelection
    case emptySessionTitle
    case emptyAvatar
    case passwordTooShort
    case passwordMismatch
    case emptyDeviceName
    case invalidPairingCode
    case pairingNotClaimed
    case signedInServerUnavailable
    case invalidRuntimeConfigSchema
    case tooManyAttachments(maximum: Int)
    case emptyAttachment(name: String)
    case invalidPageSize

    var errorDescription: String? {
        switch self {
        case .emptyMessage:
            return String(localized: "Enter a message before sending.")
        case .emptySessionSelection:
            return String(localized: "Select at least one session.")
        case .emptySessionTitle:
            return String(localized: "Enter a session title.")
        case .emptyAvatar:
            return String(localized: "Choose an avatar image before uploading.")
        case .passwordTooShort:
            return String(localized: "Password must be at least 8 characters.")
        case .passwordMismatch:
            return String(localized: "Passwords do not match.")
        case .emptyDeviceName:
            return String(localized: "Enter a device name before continuing.")
        case .invalidPairingCode:
            return String(localized: "Enter the 6-digit pairing code shown on the device.")
        case .pairingNotClaimed:
            return String(localized: "The server did not accept this pairing request.")
        case .signedInServerUnavailable:
            return String(localized: "The signed-in server is unavailable.")
        case .invalidRuntimeConfigSchema:
            return String(localized: "The runtime configuration schema is unavailable or invalid.")
        case let .tooManyAttachments(maximum):
            return "Attach no more than \(maximum) files."
        case let .emptyAttachment(name):
            return "The attachment '\(name)' is empty."
        case .invalidPageSize:
            return String(localized: "The requested page size is outside the supported range.")
        }
    }
}

struct V2LocalAttachment: Hashable {
    let fileId: V2AttachmentID
    let name: String
    let mediaType: String
    let data: Data
    let sha256: String?
}
