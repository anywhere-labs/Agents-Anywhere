import SwiftUI

/// The real app's `ChatComposer` (glass pill → expanded card, one persistent UITextView), without attachments
/// and slash commands.
struct ChatComposer: View {
    @Bindable var draft: ComposerDraft
    let editor: ComposerEditorController
    let isStreaming: Bool
    var canSend = true
    var placeholder = "询问 Agents"
    let maximumEditorHeight: CGFloat
    let controls: ChatControlMetrics
    let onSend: () -> Void
    let onStop: () -> Void
    let onOptions: () -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var glass

    var body: some View {
        GlassEffectContainer(spacing: 12) {
            ComposerLayout(expanded: draft.isExpanded, maximumEditorHeight: maximumEditorHeight, controls: controls) {
                Button(action: onOptions) {
                    AppSymbol("plus", size: 24)
                        .frame(width: controls.touchTarget, height: controls.touchTarget)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("附件与对话选项")

                ZStack(alignment: .topLeading) {
                    if draft.text.isEmpty {
                        Text(placeholder)
                            .font(.body)
                            .lineLimit(1)
                            .foregroundStyle(.secondary)
                            .allowsHitTesting(false)
                    }
                    NativeComposerEditor(draft: draft, controller: editor, maximumHeight: maximumEditorHeight, onCommandSend: onSend)
                }

                let enabled = isStreaming || (canSend && draft.canAttemptSend)
                Button(action: isStreaming ? onStop : onSend) {
                    AppSymbol(isStreaming ? "stop.fill" : "arrow.up", size: isStreaming ? 13 : 18)
                        .contentTransition(.symbolEffect(.replace))
                        .foregroundStyle(AppTheme.primaryControlForeground(colorScheme))
                        .frame(width: controls.sendDiameter, height: controls.sendDiameter)
                        .background(AppTheme.primaryControlBackground(colorScheme).opacity(enabled ? 1 : 0.42), in: Circle())
                        .frame(width: controls.touchTarget, height: controls.touchTarget)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .disabled(!enabled)
                .accessibilityLabel(isStreaming ? "停止生成" : "发送消息")
            }
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: draft.isExpanded ? controls.expandedCornerRadius : controls.collapsedCornerRadius))
            .glassEffectID("composer", in: glass)
            .chromeRegion("composer")
        }
        .padding(.horizontal, draft.isExpanded ? ChatControlMetrics.expandedHorizontalInset : ChatControlMetrics.collapsedHorizontalInset)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .animation(reduceMotion ? nil : .smooth(duration: 0.24), value: draft.isExpanded)
    }
}
