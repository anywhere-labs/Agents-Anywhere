import SwiftUI
import UIKit

/// Keep this controller and the underlying UITextView alive while the glass
/// container changes layout. Never derive submission from SwiftUI .onSubmit.
@MainActor @Observable
final class ComposerEditorController {
    @ObservationIgnored weak var textView: ComposerTextView?
    @ObservationIgnored weak var draft: ComposerDraft?

    func finishEditing() {
        guard let textView else { return }
        textView.resignFirstResponder()
        synchronize()
    }

    /// Check native marked text before ending editing. unmarkText() only removes
    /// the mark; it cannot select the user's intended Chinese candidate.
    func committedTextForSend() async -> String? {
        guard let textView else { return draft?.isComposing == false ? draft?.text : nil }
        guard textView.markedTextRange == nil else { synchronize(); return nil }
        let originalDraft = draft
        textView.resignFirstResponder()
        await Task.yield()
        guard !Task.isCancelled, draft === originalDraft, textView.markedTextRange == nil else { return nil }
        synchronize()
        return textView.text ?? ""
    }

    func synchronize() {
        guard let textView, let draft else { return }
        if draft.text != textView.text { draft.text = textView.text ?? "" }
        draft.isComposing = textView.markedTextRange != nil
        draft.isFocused = textView.isFirstResponder
    }
}

final class ComposerTextView: UITextView {
    var commandSend: (() -> Void)?

    override var keyCommands: [UIKeyCommand]? {
        let send = UIKeyCommand(title: "发送", action: #selector(sendWithCommandReturn), input: "\r", modifierFlags: .command)
        send.wantsPriorityOverSystemBehavior = true
        return (super.keyCommands ?? []) + [send]
    }

    @objc private func sendWithCommandReturn() {
        // Leave provisional text and the candidate bar intact. Return/Space or
        // a candidate tap remains owned by the IME; this shortcut never guesses.
        guard markedTextRange == nil else { return }
        commandSend?()
    }
}

struct NativeComposerEditor: UIViewRepresentable {
    @Bindable var draft: ComposerDraft
    let controller: ComposerEditorController
    let maximumHeight: CGFloat
    let onCommandSend: () -> Void

    func makeUIView(context: Context) -> ComposerTextView {
        let view = ComposerTextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textColor = .label
        view.tintColor = .systemBlue
        view.returnKeyType = .default
        view.enablesReturnKeyAutomatically = false
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.contentInset = .zero
        view.isScrollEnabled = false
        view.showsVerticalScrollIndicator = true
        view.keyboardDismissMode = .none
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.accessibilityLabel = "消息"
        view.accessibilityHint = "回车换行，Command 加回车发送。"
        view.accessibilityIdentifier = "chat.composer.editor"
        controller.textView = view; controller.draft = draft
        return view
    }

    func updateUIView(_ view: ComposerTextView, context: Context) {
        context.coordinator.parent = self
        controller.textView = view; controller.draft = draft
        view.commandSend = onCommandSend
        // Do not replace native pre-edit text or disrupt its selection/candidate bar.
        if view.markedTextRange == nil, view.text != draft.text {
            let selection = view.selectedRange
            view.text = draft.text
            let end = (draft.text as NSString).length
            view.selectedRange = NSRange(location: min(selection.location, end), length: 0)
        }
        if draft.isFocused, !view.isFirstResponder {
            view.becomeFirstResponder()
        } else if !draft.isFocused, view.isFirstResponder {
            view.resignFirstResponder()
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }
        let measured = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let minimum = ceil(uiView.font?.lineHeight ?? 24)
        let height = min(maximumHeight, max(minimum, ceil(measured)))
        let shouldScroll = measured > maximumHeight + 1
        if uiView.isScrollEnabled != shouldScroll { uiView.isScrollEnabled = shouldScroll }
        return CGSize(width: width, height: height)
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: NativeComposerEditor
        init(_ parent: NativeComposerEditor) { self.parent = parent }
        func textViewDidChange(_ textView: UITextView) {
            parent.controller.synchronize()
            textView.invalidateIntrinsicContentSize()
        }
        func textViewDidChangeSelection(_ textView: UITextView) { parent.controller.synchronize() }
        func textViewDidBeginEditing(_ textView: UITextView) { parent.controller.synchronize() }
        func textViewDidEndEditing(_ textView: UITextView) { parent.controller.synchronize() }
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            // UIKit owns IME candidate confirmation. A plain Return is always
            // accepted as text input, never interpreted as a send gesture.
            true
        }
    }
}
