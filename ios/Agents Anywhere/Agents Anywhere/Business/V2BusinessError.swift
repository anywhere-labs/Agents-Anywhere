import Foundation

enum V2BusinessError: LocalizedError {
    case emptyMessage
    case emptySessionSelection
    case tooManyAttachments(maximum: Int)
    case emptyAttachment(name: String)
    case invalidPageSize

    var errorDescription: String? {
        switch self {
        case .emptyMessage:
            return "Enter a message before sending."
        case .emptySessionSelection:
            return "Select at least one session."
        case let .tooManyAttachments(maximum):
            return "Attach no more than \(maximum) files."
        case let .emptyAttachment(name):
            return "The attachment '\(name)' is empty."
        case .invalidPageSize:
            return "The requested page size is outside the supported range."
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
