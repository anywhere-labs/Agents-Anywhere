import SwiftUI

/// A fixed-size preview. Draft forms and verbose diagnostics live in sheets,
/// so acknowledgement/network revisions cannot resize the timeline's inset.
struct SessionInteractionCard: View {
    let item: SessionNoticeModel
    let chat: SessionChatModel
    var page: String? = nil
    var height: CGFloat? = nil
    var onExpand: (() -> Void)? = nil
    @State private var destination: Destination?
    private enum Destination: String, Identifiable {
        case expanded, details
        var id: String { rawValue }
    }
    var metrics = SessionInteractionMetrics()

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { timeline in
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .center, spacing: 8) {
                    Image(systemName: item.form == nil ? "checkmark.shield" : "text.bubble")
                        .font(.subheadline)
                    Text(title).font(.subheadline.weight(.semibold))
                        .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                    Button("操作详情") { destination = .details }
                        .font(.caption).fixedSize().frame(minHeight: 44)
                    Button {
                        if let onExpand { onExpand() } else { destination = .expanded }
                    } label: {
                        VStack(spacing: 2) {
                            Text("展开")
                            if let page { Text(page).font(.caption2).monospacedDigit() }
                        }.font(.caption).frame(minWidth: 44, minHeight: 44)
                    }.buttonStyle(.plain)
                }
                .foregroundStyle(item.notice.severity == "error" ? Color.red : Color.primary)
                .frame(height: metrics.titleHeight, alignment: .center)

                let status = status(at: timeline.date)
                VStack(alignment: .leading, spacing: 1) {
                    Text(summary).font(.system(.subheadline, design: item.notice.interactionType == "approval" ? .monospaced : .default))
                        .lineLimit(status.isEmpty ? 2 : 1)
                    if !status.isEmpty { Text(status).font(.caption).lineLimit(1) }
                }
                .foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                .frame(height: metrics.lineHeight * 2, alignment: .topLeading).clipped()

                if item.notice.type == "interaction" {
                    SessionInteractionActions(item: item, chat: chat, now: timeline.date, compact: true,
                        onEdit: { if let onExpand { onExpand() } else { destination = .expanded } })
                        .frame(height: metrics.actionHeight)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .frame(height: height ?? metrics.compactHeight)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(.regular, in: .rect(cornerRadius: 24))
        }
        .sheet(item: $destination) { target in
            switch target {
            case .expanded: SessionNoticesSheet(model: chat, initialNoticeID: item.id)
            case .details: SessionInteractionDetailsSheet(item: item, chat: chat)
            }
        }
    }

    private var title: String {
        switch item.notice.title {
        case "Codex wants to run a command": "Codex 请求执行命令"
        case "Codex wants to edit files": "Codex 请求修改文件"
        case "Codex requests additional permissions": "Codex 请求额外权限"
        case "Claude wants to use a tool": "Claude 请求使用工具"
        default: item.notice.title
        }
    }
    private var summary: String {
        if let message = item.notice.message, !message.isEmpty { return message }
        if let question = item.form?.questions.first { return question.prompt }
        return TimelineText.command(item.notice.context["command"])
            ?? TimelineText.command(item.notice.context["toolInput"]?["command"]) ?? ""
    }
    private func status(at now: Date) -> String {
        switch item.submission {
        case .sending: return "正在提交…"
        case .accepted: return "已提交，等待 Agent"
        case .uncertain: return "结果未确认 · 查看详情"
        case .unavailable: return "此交互已结束"
        case .idle: break
        }
        if item.isExpired(at: now) { return "此交互已过期" }
        if item.responseError != nil || item.notice.status == .failed { return "回应失败 · 查看详情" }
        if chat.responseUnavailableReason != nil { return "连接不可用 · 查看详情" }
        if [.responding, .responseAccepted, .resolving].contains(item.notice.status) { return "Agent 正在处理…" }
        if let form = item.form { return "\(form.questions.count) 个问题" }
        return ""
    }
}

struct SessionInteractionActions: View {
    let item: SessionNoticeModel
    let chat: SessionChatModel
    let now: Date
    var compact = false
    var onEdit: (() -> Void)? = nil

    var body: some View {
        let layout = NoticeActionPresentation(item.notice.actions)
        if compact {
            HStack(spacing: 8) {
                buttons(layout.direct, intrinsic: false)
                if !layout.more.isEmpty {
                    Menu {
                        ForEach(layout.more) { action in
                            Button(NoticeActionPresentation.title(action, notice: item.notice),
                                systemImage: NoticeActionPresentation.symbol(action), role: action.style == "danger" ? .destructive : nil) {
                                    respond(action)
                                }
                                .disabled(isDisabled(action))
                        }
                    } label: {
                        Label("更多", systemImage: "ellipsis")
                            .opacity(layout.more.contains(where: item.isSending) ? 0 : 1)
                            .overlay {
                                if layout.more.contains(where: item.isSending) { ProgressView().controlSize(.small) }
                            }
                    }
                    .font(.subheadline).buttonStyle(.glass).buttonBorderShape(.capsule).controlSize(.large)
                    .disabled(chat.isWorking || !item.canRespond(fresh: chat.session.runtime.isFresh, at: now))
                    .fixedSize()
                }
            }
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { buttons(item.notice.actions, intrinsic: true) }.fixedSize(horizontal: true, vertical: false)
                VStack(spacing: 8) { buttons(item.notice.actions, intrinsic: false) }
            }
        }
    }
    @ViewBuilder private func buttons(_ actions: [V2RuntimeNoticeAction], intrinsic: Bool) -> some View {
        ForEach(actions) { action in
            AppGlassButton(NoticeActionPresentation.title(action, notice: item.notice),
                systemImage: compact ? nil : NoticeActionPresentation.symbol(action),
                role: action.style == "danger" ? .destructive : nil,
                style: action.style == "primary" ? .prominent : .regular,
                isLoading: item.isSending(action), disabled: isDisabled(action), maxWidth: intrinsic ? nil : .infinity) {
                    respond(action)
                }
                .font(.subheadline)
                .accessibilityHint(!item.hasValidInput(for: action) && onEdit != nil ? "打开表单，填写后提交" : "")
        }
    }
    private func isDisabled(_ action: V2RuntimeNoticeAction) -> Bool {
        chat.isWorking || !item.canRespond(fresh: chat.session.runtime.isFresh, at: now)
            || (!item.hasValidInput(for: action) && onEdit == nil)
    }
    private func respond(_ action: V2RuntimeNoticeAction) {
        if !item.hasValidInput(for: action), let onEdit { onEdit() }
        else { Task { await chat.respond(notice: item, action: action) } }
    }
}

/// Shared scaled slots keep every page aligned, including during loading.
struct SessionInteractionMetrics: DynamicProperty {
    @ScaledMetric(relativeTo: .subheadline) var lineHeight: CGFloat = 20
    @ScaledMetric(relativeTo: .body) var actionHeight: CGFloat = 50
    var titleHeight: CGFloat { max(44, lineHeight * 2) }
    var minimumHeight: CGFloat { titleHeight + actionHeight + 32 }
    var compactHeight: CGFloat { minimumHeight + lineHeight * 2 }
}
