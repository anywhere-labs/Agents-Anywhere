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
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: item.form == nil ? "checkmark.shield" : "text.bubble")
                        .font(.subheadline).padding(.top, 3)
                    Text(item.notice.title).font(.subheadline.weight(.semibold))
                        .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
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
                .frame(height: metrics.titleHeight, alignment: .top)

                Text(summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).clipped()

                HStack(spacing: 8) {
                    Text(status(at: timeline.date)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 0)
                    Button("操作详情", systemImage: "arrow.up.right.square") { destination = .details }
                        .font(.caption).fixedSize().frame(minHeight: 44)
                }.frame(height: 44)

                if item.notice.type == "interaction" {
                    SessionInteractionActions(item: item, chat: chat, now: timeline.date, compact: true,
                        onEdit: { if let onExpand { onExpand() } else { destination = .expanded } })
                        .frame(height: metrics.actionHeight)
                }
            }
            .padding(14)
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
        if compact && item.notice.actions.count > 2 {
            ScrollView(.horizontal) {
                HStack(spacing: 8) { buttons(intrinsic: true) }.padding(.horizontal, 2)
            }.scrollIndicators(.hidden).scrollClipDisabled()
        } else if compact {
            HStack(spacing: 8) { buttons(intrinsic: false) }
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { buttons(intrinsic: true) }.fixedSize(horizontal: true, vertical: false)
                VStack(spacing: 8) { buttons(intrinsic: false) }
            }
        }
    }
    @ViewBuilder private func buttons(intrinsic: Bool) -> some View {
        ForEach(item.notice.actions) { action in
            let needsInput = !item.hasValidInput(for: action)
            AppGlassButton(actionTitle(action), systemImage: actionIcon(action),
                role: action.style == "danger" ? .destructive : nil,
                style: action.style == "primary" ? .prominent : .regular,
                isLoading: item.isSending(action),
                disabled: chat.isWorking || !item.canRespond(fresh: chat.session.runtime.isFresh, at: now)
                    || (needsInput && onEdit == nil), maxWidth: intrinsic ? nil : .infinity) {
                    if needsInput, let onEdit { onEdit() }
                    else { Task { await chat.respond(notice: item, action: action) } }
                }
                .accessibilityHint(needsInput && onEdit != nil ? "打开表单，填写后提交" : "")
        }
    }
    private func actionTitle(_ action: V2RuntimeNoticeAction) -> String {
        switch action.id {
        case "approve": "批准"
        case "approve_for_session": "本会话批准"
        case "reject": "拒绝"
        case "cancel", "dismiss": "取消"
        case "submit": "提交"
        default: action.label
        }
    }
    private func actionIcon(_ action: V2RuntimeNoticeAction) -> String {
        switch action.id {
        case "reject", "cancel", "dismiss": "xmark"
        case "approve_for_session": "checkmark.shield"
        default: "checkmark"
        }
    }
}

/// Shared scaled slots keep every page aligned, including during loading.
struct SessionInteractionMetrics: DynamicProperty {
    @ScaledMetric(relativeTo: .subheadline) var lineHeight: CGFloat = 20
    @ScaledMetric(relativeTo: .body) var actionHeight: CGFloat = 50
    var titleHeight: CGFloat { max(44, lineHeight * 2) }
    var minimumHeight: CGFloat { titleHeight + 44 + actionHeight + 52 }
    var compactHeight: CGFloat { minimumHeight + lineHeight * 2 }
}
