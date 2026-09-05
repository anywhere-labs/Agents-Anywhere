import SwiftUI

struct ChatComposer: View {
    @Bindable var draft: ComposerDraft
    let editor: ComposerEditorController
    let isStreaming: Bool
    var canSend = true
    var canStop = true
    var isBusy = false
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
            VStack(spacing: 0) {
                if !draft.attachments.isEmpty { attachmentTray }
                ComposerLayout(expanded: draft.isExpanded, maximumEditorHeight: maximumEditorHeight, controls: controls) {
                    Button(action: onOptions) {
                        Image(systemName: "plus")
                            .font(.system(size: 24, weight: .regular))
                            .frame(width: controls.touchTarget, height: controls.touchTarget)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("附件与对话选项")
                    .accessibilityIdentifier("chat.composer.options")

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

                    Button(action: isStreaming ? onStop : onSend) {
                        Image(systemName: isStreaming ? "stop.fill" : "arrow.up")
                            .font(.system(size: isStreaming ? 13 : 18, weight: .regular))
                            .contentTransition(.symbolEffect(.replace))
                            .foregroundStyle(AppTheme.primaryControlForeground(colorScheme))
                            .frame(width: controls.sendDiameter, height: controls.sendDiameter)
                            .background(AppTheme.primaryControlBackground(colorScheme).opacity((isStreaming ? canStop : canSend && draft.canAttemptSend) && !isBusy ? 1 : 0.42), in: Circle())
                            .frame(width: controls.touchTarget, height: controls.touchTarget)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(isBusy || (isStreaming ? !canStop : !canSend || !draft.canAttemptSend))
                    .accessibilityLabel(isStreaming ? "停止生成" : "发送消息")
                    .accessibilityHint(draft.isComposing ? "请先确认输入法候选文字" : "")
                    .accessibilityIdentifier("chat.composer.send")
                }
            }
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: draft.isExpanded ? controls.expandedCornerRadius : controls.collapsedCornerRadius))
            .glassEffectID("composer", in: glass)
        }
        .padding(.horizontal, draft.isExpanded ? ChatControlMetrics.expandedHorizontalInset : ChatControlMetrics.collapsedHorizontalInset)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .animation(reduceMotion ? nil : .smooth(duration: 0.24), value: draft.isExpanded)
        .sensoryFeedback(.impact(weight: .light), trigger: isStreaming)
    }

    private var attachmentTray: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(draft.attachments) { attachment in
                    ChatComposerAttachment(attachment: attachment) {
                        draft.attachments.removeAll { $0.id == attachment.id }
                    }
                }
            }
        }
        .scrollIndicators(.hidden)
        .padding(.horizontal, 12)
        .padding(.top, 12)
    }
}
