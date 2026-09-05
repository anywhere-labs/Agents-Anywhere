import Foundation
import Observation

struct ChatAttachment: Identifiable, Equatable {
    let id: String
    let name: String
    let data: Data
    let mediaType: String
    var uploaded: V2AttachmentReference?

    init(id: String = UUID().uuidString, name: String, data: Data, mediaType: String) {
        self.id = id; self.name = name; self.data = data; self.mediaType = mediaType
    }

    var isImage: Bool { mediaType.hasPrefix("image/") }
    var local: V2LocalAttachment {
        V2LocalAttachment(fileId: id, name: name, mediaType: mediaType, data: data, sha256: nil)
    }
}

/// The editor owns marked-text state; the account/session owns the draft lifetime.
@MainActor @Observable
final class ComposerDraft {
    private(set) var isValid = true
    var text = ""
    var attachments: [ChatAttachment] = []
    var isFocused = false
    var isComposing = false

    var isExpanded: Bool { isFocused || !text.isEmpty || !attachments.isEmpty }
    var hasSendableContent: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty }
    var canAttemptSend: Bool { !isComposing && hasSendableContent }

    func clear() { text = ""; attachments = []; isComposing = false }
    func invalidate() { clear(); isFocused = false; isValid = false }
}
