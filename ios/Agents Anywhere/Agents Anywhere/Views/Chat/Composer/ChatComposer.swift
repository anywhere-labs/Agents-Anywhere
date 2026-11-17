import SwiftUI

/// 跨页共享 composer 玻璃的 namespace：detail 切换（会话→新会话）时两页
/// composer 若各自持有 namespace，新页 glass "从无到有"的 Liquid Glass
/// 出现动画在 Duo 横屏宽 detail 下闪现大圆泡泡（2026-10-27 真机定位，
/// 圈出现在底部输入区；竖屏 NavigationStack 有 push 过渡掩盖、15PM
/// 横屏 detail 窄泡泡不明显）。共享后同 ID glass 做 matched 过渡。
private struct ComposerGlassNamespaceKey: EnvironmentKey {
    static let defaultValue: Namespace.ID? = nil
}
extension EnvironmentValues {
    var composerGlassNamespace: Namespace.ID? {
        get { self[ComposerGlassNamespaceKey.self] }
        set { self[ComposerGlassNamespaceKey.self] = newValue }
    }
}

struct ChatComposer: View {
    @Bindable var draft: ComposerDraft
    let editor: ComposerEditorController
    let isStreaming: Bool
    var canSend = true
    var canStop = true
    var isBusy = false
    var placeholder = String(localized: "询问 Agents")
    let maximumEditorHeight: CGFloat
    let controls: ChatControlMetrics
    let onSend: () -> Void
    let onStop: () -> Void
    let onOptions: () -> Void
    /// Shown beside send when the session's runtime offers slash commands.
    var showsCommands = false
    var commandsActive = false
    var onCommands: () -> Void = {}
    /// Reports draft mutations from this subtree only. Persisting the draft
    /// must not make the page root observe the editor's text.
    var onDraftChange: () -> Void = {}
    /// While the Agent runs and messages can queue, a typed draft is sent to
    /// the queue; an empty draft still stops the turn.
    var queueMode = false
    /// Other ways to send, offered on long-press of the send button.
    var alternativeDeliveries: [V2MessageDelivery] = []
    var onSendWith: (V2MessageDelivery) -> Void = { _ in }
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.composerGlassNamespace) private var sharedGlass
    @Namespace private var glass

    var body: some View {
        GlassEffectContainer(spacing: 12) {
            VStack(spacing: 0) {
                if !draft.attachments.isEmpty { attachmentTray }
                // 上游同款行为：随内容增高，超上限后 sizeThatFits 切回
                // isScrollEnabled=true 由系统接管滚动与光标跟随。曾试过
                // Duo 全域 collapsed + 手动 setContentOffset 光标跟随，
                // 真机上第三行起布局溢出盖按钮，回归上游（2026-10-28）。
                ComposerLayout(expanded: draft.isExpanded,
                    maximumEditorHeight: maximumEditorHeight, controls: controls) {
                    Button(action: onOptions) {
                        AppSymbol("plus", size: 24)
                            .frame(width: controls.touchTarget, height: controls.touchTarget)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(String(localized: "附件与对话选项"))
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

                    Button(action: showsStop ? onStop : onSend) {
                        AppSymbol(showsStop ? "stop.fill" : "arrow.up", size: showsStop ? 13 : 18)
                            .contentTransition(.symbolEffect(.replace))
                            .foregroundStyle(AppTheme.primaryControlForeground(colorScheme))
                            .frame(width: controls.sendDiameter, height: controls.sendDiameter)
                            .background(AppTheme.primaryControlBackground(colorScheme).opacity((showsStop ? canStop : canSend && draft.canAttemptSend) && !isBusy ? 1 : 0.42), in: Circle())
                            .frame(width: controls.touchTarget, height: controls.touchTarget)
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(isBusy || (showsStop ? !canStop : !canSend || !draft.canAttemptSend))
                    .contextMenu {
                        if !showsStop, !isBusy, canSend, draft.canAttemptSend, !alternativeDeliveries.isEmpty {
                            Button(String(localized: "排队"), systemImage: "text.badge.plus", action: onSend)
                            ForEach(alternativeDeliveries, id: \.self) { delivery in
                                Button(delivery == .steer ? String(localized: "引导当前任务") : String(localized: "打断并发送"),
                                       systemImage: delivery == .steer ? "arrow.turn.down.right" : "bolt") { onSendWith(delivery) }
                            }
                        }
                    }
                    .accessibilityLabel(showsStop ? String(localized: "停止生成") : queueMode && isStreaming ? String(localized: "排队") : String(localized: "发送消息"))
                    .accessibilityHint(draft.isComposing ? String(localized: "请先确认输入法候选文字") : "")
                    .accessibilityIdentifier("chat.composer.send")

                    if showsCommands {
                        Button(action: onCommands) {
                            AppSymbol("command", size: 18)
                                .foregroundStyle(commandsActive ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                                .frame(width: controls.touchTarget, height: controls.touchTarget)
                                .contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(String(localized: "指令"))
                        .accessibilityAddTraits(commandsActive ? .isSelected : [])
                        .accessibilityIdentifier("chat.composer.commands")
                    }
                    // 聚焦时显示收起键盘：放在指令图标左侧（紧邻发送键易误触）。
                    // systemName 在本项目环境不渲染（全仓无先例），用 AppSymbol 资产。
                    if draft.isFocused {
                        Button {
                            // 直接 resign：只写 draft.isFocused 走 updateUIView
                            // 异步收起链，输入过文字后真机上竞态失效（键盘
                            // 不落）。同步 resign 出自按钮事件上下文，安全。
                            editor.finishEditing()
                        } label: {
                            // systemName 在本项目环境不渲染（全仓无先例，
                            // 两轮实测空白），统一用 AppSymbol 资产图标。
                            AppSymbol("chevron.down", size: 15)
                                .foregroundStyle(.secondary)
                                .frame(width: controls.touchTarget, height: controls.touchTarget)
                                .contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(String(localized: "收起键盘"))
                        .accessibilityIdentifier("chat.composer.dismissKeyboard")
                    }
                }
            }
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: draft.isExpanded ? controls.expandedCornerRadius : controls.collapsedCornerRadius))
            // 页面祖先（ChatShellView）注入共享 namespace 时用共享值：跨页
            // 切换做同 ID matched 过渡，避免新页 glass 单独"泡泡式"出现。
            .glassEffectID("composer", in: sharedGlass ?? glass)
        }
        .padding(.horizontal, draft.isExpanded ? ChatControlMetrics.expandedHorizontalInset : ChatControlMetrics.collapsedHorizontalInset)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .animation(reduceMotion ? nil : .smooth(duration: 0.24), value: draft.isExpanded)
        // The composer is the only subtree that already re-evaluates on every
        // keystroke, including each Chinese IME marked-text update. Observing
        // the draft from the page root re-evaluated the whole conversation.
        .onChange(of: draft.text) { _, _ in onDraftChange() }
        .onChange(of: draft.attachments) { _, _ in onDraftChange() }
    }

    private var showsStop: Bool { isStreaming && !(queueMode && draft.hasSendableContent) }

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
