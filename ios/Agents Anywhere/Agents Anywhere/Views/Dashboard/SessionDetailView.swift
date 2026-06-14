import SwiftUI

struct SessionDetailView: View {
    @EnvironmentObject private var appState: AppState

    let initialSession: SessionSummary

    @State private var session: SessionSummary
    @State private var items: [TimelineItem] = []
    @State private var approvals: [Approval] = []
    @State private var isLoading = false
    @State private var isSending = false
    @State private var messageText = ""
    @State private var errorMessage: String?

    init(initialSession: SessionSummary) {
        self.initialSession = initialSession
        _session = State(initialValue: initialSession)
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                SessionDetailHeader(session: session)

                if isLoading && items.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 40)
                } else if items.isEmpty && approvals.isEmpty {
                    ContentUnavailableView(
                        "No Activity Yet",
                        systemImage: "text.bubble",
                        description: Text("Messages and runtime events will appear here."),
                    )
                    .padding(.top, 60)
                } else {
                    ForEach(approvals.filter { $0.targetItemId == nil && $0.status == "pending" }) { approval in
                        ApprovalCard(approval: approval)
                    }

                    ForEach(items) { item in
                        TimelineRow(
                            item: item,
                            approval: approvals.first { $0.targetItemId == item.id && $0.status == "pending" },
                        )
                    }
                }
            }
            .padding(20)
            .padding(.bottom, 90)
        }
        .navigationTitle(session.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await loadState() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(isLoading)
            }
        }
        .safeAreaInset(edge: .bottom) {
            GlassMessageInputBar(text: $messageText, isSending: isSending) {
                Task { await sendMessage() }
            }
        }
        .alert("Session Error", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } },
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "Something went wrong.")
        }
        .task {
            await markRead()
            await loadState()
        }
    }

    private func loadState() async {
        guard let api = appState.api, let token = appState.accessToken() else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            var afterSeq = 0
            var collected: [TimelineItem] = []
            var latestApprovals: [Approval] = []
            var latestSession = session
            var hasMore = true
            while hasMore {
                let response = try await api.getSessionState(
                    token: token,
                    sessionId: initialSession.id,
                    afterSeq: afterSeq,
                    limit: 200,
                )
                collected.append(contentsOf: response.items)
                latestApprovals = response.approvals
                latestSession = response.session
                hasMore = response.hasMore
                guard let last = response.items.last, last.updatedSeq > afterSeq else {
                    break
                }
                afterSeq = last.updatedSeq
            }
            session = latestSession
            items = collected.sorted { $0.orderSeq < $1.orderSeq }
            approvals = latestApprovals
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func markRead() async {
        guard initialSession.unread, let api = appState.api, let token = appState.accessToken() else { return }
        _ = try? await api.markSessionRead(token: token, sessionId: initialSession.id)
    }

    private func sendMessage() async {
        let trimmed = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let api = appState.api, let token = appState.accessToken() else { return }
        isSending = true
        defer { isSending = false }
        do {
            _ = try await api.sendSessionMessage(token: token, sessionId: initialSession.id, content: trimmed)
            messageText = ""
            await loadState()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct SessionDetailHeader: View {
    let session: SessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(session.displayTitle)
                .font(.title2.weight(.bold))
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                Label(session.runtime, systemImage: session.runtimeIcon)
                Text(session.connectorStatus)
                Text(session.statusLabel)
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            if let cwd = session.cwd {
                Text(cwd)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(.regularMaterial)
        }
    }
}

private struct TimelineRow: View {
    let item: TimelineItem
    let approval: Approval?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .foregroundStyle(color)
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text(item.status.capitalized)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let text = item.displayText, !text.isEmpty {
                Text(text)
                    .font(.body)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let approval {
                ApprovalCard(approval: approval)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(background)
        }
    }

    private var title: String {
        if item.type == "message" {
            return item.role?.capitalized ?? "Message"
        }
        if item.type == "tool" {
            return item.content["function"]?.stringValue
                ?? item.content["name"]?.stringValue
                ?? item.content["tool"]?.stringValue
                ?? "Tool"
        }
        if item.type == "system" {
            return item.content["kind"]?.stringValue ?? "System"
        }
        return item.type
    }

    private var icon: String {
        switch item.type {
        case "message":
            return item.role == "user" ? "person.fill" : "sparkles"
        case "tool":
            return "hammer"
        case "system":
            return "info.circle"
        case "artifact":
            return "doc.text"
        default:
            return "circle"
        }
    }

    private var color: Color {
        switch item.status {
        case "failed":
            return .red
        case "waiting_approval":
            return .orange
        case "running":
            return .green
        default:
            return .secondary
        }
    }

    private var background: AnyShapeStyle {
        item.role == "user" ? AnyShapeStyle(.thinMaterial) : AnyShapeStyle(.regularMaterial)
    }
}

private struct ApprovalCard: View {
    let approval: Approval

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Approval Required", systemImage: "checkmark.shield")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text(approval.kind.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text(approval.title)
                .font(.headline)

            if let description = approval.description, !description.isEmpty {
                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(.orange.opacity(0.14))
        }
    }
}

struct GlassMessageInputBar: View {
    @Binding var text: String
    var isSending = false
    var showsAttachmentButton = false
    let onSend: () -> Void

    private var canSend: Bool {
        !isSending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            if showsAttachmentButton {
                Button {
                } label: {
                    Image(systemName: "plus")
                        .font(.title3)
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.borderless)
            }

            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message", text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.plain)
                    .submitLabel(.send)
                    .onSubmit {
                        if canSend {
                            onSend()
                        }
                    }

                Button {
                    if canSend {
                        onSend()
                    }
                } label: {
                    sendIcon
                }
                .buttonStyle(.plain)
                .disabled(!canSend && !isSending)
            }
            .padding(.leading, 14)
            .padding(.trailing, 8)
            .padding(.vertical, 8)
            .background {
                Capsule(style: .continuous)
                    .fill(.regularMaterial)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(.bar)
    }

    @ViewBuilder
    private var sendIcon: some View {
        if isSending {
            ProgressView()
                .scaleEffect(0.75)
        } else if canSend {
            Image(systemName: "arrow.up.circle.fill")
                .font(.title2)
                .foregroundStyle(.tint)
        } else {
            Image(systemName: "mic.fill")
                .font(.title2)
                .foregroundStyle(.secondary)
        }
    }
}

extension SessionSummary {
    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return cwd ?? id
    }

    var runtimeIcon: String {
        runtime.localizedCaseInsensitiveContains("claude") ? "sparkles" : "terminal"
    }

    var sortKey: String {
        return sortAt ?? lastActivityAt ?? lastItemAt ?? ""
    }

    func isMoreRecent(than other: SessionSummary) -> Bool {
        let sortComparison = sortKey.compare(other.sortKey)
        if sortComparison != .orderedSame {
            return sortComparison == .orderedDescending
        }

        let orderSeq = lastItemOrderSeq ?? -1
        let otherOrderSeq = other.lastItemOrderSeq ?? -1
        if orderSeq != otherOrderSeq {
            return orderSeq > otherOrderSeq
        }

        return updatedSeq > other.updatedSeq
    }

    var statusLabel: String {
        switch status {
        case "running":
            return "Running"
        case "waiting_approval":
            return "Approval"
        case "error":
            return "Error"
        case "idle":
            return "Idle"
        default:
            return status.capitalized
        }
    }

    var displayTime: String {
        guard let date = activityDate else { return "" }
        let interval = Date().timeIntervalSince(date)
        if interval < 60 {
            return "now"
        }
        if interval < 60 * 60 {
            return "\(Int(interval / 60))m"
        }
        if interval < 60 * 60 * 24 {
            return "\(Int(interval / 3_600))h"
        }
        if interval < 60 * 60 * 24 * 7 {
            return "\(Int(interval / 86_400))d"
        }
        return Self.shortDateFormatter.string(from: date)
    }

    private var activityDate: Date? {
        let value = lastActivityAt ?? lastItemAt ?? sortAt
        guard let value else { return nil }
        return Self.isoDateFormatter.date(from: value)
            ?? Self.fractionalISODateFormatter.date(from: value)
    }

    private static let isoDateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let fractionalISODateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let shortDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .none
        return formatter
    }()
}

private extension TimelineItem {
    var displayText: String? {
        content["text"]?.stringValue
            ?? content["rawText"]?.stringValue
            ?? content["message"]?.stringValue
            ?? content["summary"]?.stringValue
            ?? content["command"]?.stringValue
            ?? content["cmd"]?.stringValue
    }
}
