import SwiftUI

/// Slash-command suggestions above the composer. It reads the draft itself so
/// typing only re-evaluates this panel, not the page. `forced` is the ⌘ button:
/// it lists every command regardless of the draft.
struct CommandSuggestionPanel: View {
    let chat: SessionChatModel
    @Bindable var draft: ComposerDraft
    @Binding var forced: Bool
    @State private var dismissedFor: String?

    private var slashQuery: String? {
        guard let intent = SlashIntent(draft.text), intent.isCommandLike, intent.suffix.isEmpty, !intent.multiline else { return nil }
        return intent.command
    }
    private var query: String { slashQuery ?? "" }
    private var suggestions: [V2RuntimeCommand] { chat.commands.filter { $0.matches(query) } }
    private var isVisible: Bool {
        guard chat.offersCommands, draft.attachments.isEmpty || forced else { return false }
        if forced { return true }
        guard slashQuery != nil, dismissedFor != draft.text else { return false }
        // Typing "/" explains why commands cannot run; longer text stays a message.
        if chat.commandsUnavailableReason != nil { return draft.text.trimmingCharacters(in: .whitespaces) == "/" }
        return !suggestions.isEmpty || (chat.commands.isEmpty && (chat.isLoadingCommands || chat.commandsError != nil))
    }

    var body: some View {
        if isVisible {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(String(localized: "指令")).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    Spacer()
                    Button { if forced { forced = false } else { dismissedFor = draft.text } } label: {
                        AppSymbol("xmark", size: 11).frame(width: 36, height: 36)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(String(localized: "关闭"))
                }
                .padding(.leading, 16).padding(.trailing, 4)
                content
            }
            .padding(.bottom, 8)
            .glassEffect(.regular, in: .rect(cornerRadius: 22))
            .padding(.horizontal, draft.isExpanded ? ChatControlMetrics.expandedHorizontalInset : ChatControlMetrics.collapsedHorizontalInset)
            .transition(.opacity)
            .task(id: chat.canUseCommands) { await chat.loadCommands() }
        }
    }

    @ViewBuilder private var content: some View {
        if let reason = chat.commandsUnavailableReason {
            message(reason, symbol: "info.circle")
        } else if chat.commands.isEmpty && chat.isLoadingCommands {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(String(localized: "正在读取指令…")).font(.subheadline).foregroundStyle(.secondary)
            }.padding(.horizontal, 16).padding(.vertical, 8)
        } else if chat.commands.isEmpty, chat.commandsError != nil {
            VStack(alignment: .leading, spacing: 4) {
                message(String(localized: "无法读取指令。"), symbol: "exclamationmark.circle")
                Button(String(localized: "重试")) { Task { await chat.loadCommands(force: true) } }
                    .font(.footnote.weight(.medium)).padding(.horizontal, 16).frame(minHeight: 36)
            }
        } else if suggestions.isEmpty {
            message(String(localized: "没有匹配的指令"), symbol: "magnifyingglass")
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(suggestions) { command in row(command) }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: 240)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func message(_ text: String, symbol: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            AppSymbol(symbol, size: 14).foregroundStyle(.secondary)
            Text(text).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    private func row(_ command: V2RuntimeCommand) -> some View {
        let block = chat.commandBlock(command)
        return Button {
            forced = false
            Task { await chat.choose(command) }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(verbatim: "/\(command.id)").font(.body.monospaced()).foregroundStyle(.primary)
                    if let hint = command.argumentHint {
                        Text(hint).font(.footnote.monospaced()).foregroundStyle(.tertiary).lineLimit(1)
                    }
                }
                let detail = block.map { chat.commandBlockMessage(command, $0) } ?? command.description ?? (command.title == command.id ? nil : command.title)
                if let detail, !detail.isEmpty {
                    Text(detail).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 16).padding(.vertical, 4)
            .contentShape(Rectangle())
            .opacity(block == nil ? 1 : 0.5)
        }
        .buttonStyle(.plain)
        .disabled(chat.isRunningCommand)
        .accessibilityIdentifier("chat.command.\(command.id)")
    }
}
