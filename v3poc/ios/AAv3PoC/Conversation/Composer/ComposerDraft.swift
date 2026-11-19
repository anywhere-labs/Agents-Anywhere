import Foundation
import Observation

/// The composer's text. A trimmed copy of the real app's `ComposerDraft`: attachments are only shown as a picker in
/// the PoC, never uploaded.
@MainActor @Observable
final class ComposerDraft {
    private(set) var isValid = true
    var text = ""
    var isFocused = false
    var isComposing = false

    var isExpanded: Bool { isFocused || !text.isEmpty }
    var hasSendableContent: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var canAttemptSend: Bool { !isComposing && hasSendableContent }

    func clear() { text = ""; isComposing = false }
}
