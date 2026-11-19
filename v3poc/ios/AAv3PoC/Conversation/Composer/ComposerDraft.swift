import Foundation
import Observation

/// Text and IME state for the native composer.
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
