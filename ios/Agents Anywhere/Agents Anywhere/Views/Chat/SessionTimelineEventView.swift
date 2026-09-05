import SwiftUI

struct SessionTimelineGroupView: View {
    let group: ChatTimelineGroup
    let chat: SessionChatModel
    let onAttachment: (V2AttachmentContent) -> Void
    let onFile: (String) -> Void
    var turnAction: TimelineTurnAction?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            content
            if let turnAction { SessionTurnActions(action: turnAction) }
        }
    }
    @ViewBuilder private var content: some View {
        if group.kind == .single { rows }
        else {
            TimelineFold(id: "group:\(group.id)", title: group.title,
                symbol: group.kind == .reconnect ? "wifi.slash" : agentGroup ? "person.2" : "hammer",
                status: group.status, disclosures: chat.disclosures) {
                rows
            }
        }
    }
    private var agentGroup: Bool { if case .agents = group.kind { true } else { false } }
    private var rows: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(group.rows) { row in
                SessionTimelineRow(row: row, onAttachment: onAttachment, cwd: chat.session.metadata?.cwd,
                    disclosures: chat.disclosures, onFile: onFile)
                ForEach(chat.session.notices.notices.filter {
                    $0.isVisible && !$0.blocks(chat.session.id) && $0.timelineTargetID == row.id
                }) { notice in SessionInteractionCard(item: notice, chat: chat) }
            }
        }
    }
}

struct SessionTimelineEventView: View {
    let row: ChatTimelineRowModel
    let cwd: String?
    let disclosures: TimelineDisclosureState
    let onFile: (String) -> Void
    private var entry: TimelineEntryPresentation { TimelineEntryPresentation(item: row.value, cwd: cwd) }

    var body: some View {
        let value = entry
        switch value.kind {
        case .reasoning:
            if row.text.isEmpty || TimelineText.inlineSummary(row.text) != nil {
                TimelineMarkerRow(title: value.title, symbol: value.symbol, status: row.value.status)
            } else {
                TimelineFold(id: row.id, title: value.title, symbol: value.symbol, status: row.value.status, disclosures: disclosures) {
                    ChatMarkdownView(text: row.text, isStreaming: row.isRevealing, resolvesFileReferences: true)
                        .id(row.layoutGeneration).padding(.leading, 24).foregroundStyle(.secondary)
                }
            }
        case .compact:
            HStack(spacing: 12) {
                Rectangle().fill(.quaternary).frame(height: 1)
                Text(value.title).font(.caption).foregroundStyle(row.value.status.isFailure ? Color.red : .secondary).fixedSize()
                Rectangle().fill(.quaternary).frame(height: 1)
            }.padding(.vertical, 8)
        case .tool:
            if value.command != nil || value.output != nil || value.input != nil || !value.changes.isEmpty {
                TimelineFold(id: row.id, title: value.title, symbol: value.symbol, status: row.value.status, disclosures: disclosures) {
                    VStack(spacing: 0) {
                        if let command = value.command { TimelineCodePanel(label: "command", code: command) }
                        if let input = value.input, input != .null && input != .object([:]) {
                            TimelineCodePanel(label: "input", code: input.formattedJSON)
                        }
                        ForEach(value.changes) { change in
                            TimelineFileChangeView(change: change, onFile: onFile)
                        }
                        if let output = value.output { TimelineCodePanel(label: "output", code: output) }
                    }.clipShape(.rect(cornerRadius: 14))
                }
            } else { TimelineMarkerRow(title: value.title, symbol: value.symbol, status: row.value.status) }
        case .artifact:
            VStack(alignment: .leading, spacing: 8) {
                if let path = value.filePath {
                    Button { onFile(path) } label: { TimelineMarkerRow(title: value.title, symbol: value.symbol, status: row.value.status, accessory: "arrow.up.right") }
                        .buttonStyle(.plain).accessibilityHint("打开文件预览")
                } else if let url = value.externalURL {
                    Link(destination: url) { TimelineMarkerRow(title: value.title, symbol: value.symbol, status: row.value.status, accessory: "arrow.up.right") }
                        .buttonStyle(.plain)
                } else { TimelineMarkerRow(title: value.title, symbol: value.symbol, status: row.value.status) }
            }
        case .marker:
            if let detail = value.detail {
                TimelineFold(id: row.id, title: value.title, symbol: value.symbol, status: row.value.status, disclosures: disclosures) {
                    TimelineCodePanel(label: "details", code: detail.formattedJSON).clipShape(.rect(cornerRadius: 14))
                }
            } else { TimelineMarkerRow(title: value.title, symbol: value.symbol, status: row.value.status) }
        }
    }
}

struct TimelineMarkerRow: View {
    let title: String
    let symbol: String
    let status: V2TimelineItemStatus
    var expanded: Bool?
    var accessory: String?
    var body: some View {
        HStack(spacing: 8) {
            if let expanded { Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(size: 10, weight: .medium)).frame(width: 10) }
            Image(systemName: symbol).font(.system(size: 15)).frame(width: 18)
            Text(title).font(.system(.subheadline, design: .monospaced)).lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            if status.isActive || status.isFailure {
                Text(status.label).font(.caption2).fixedSize().padding(.horizontal, 6).padding(.vertical, 3)
                    .background(.quaternary.opacity(0.5), in: .capsule)
            }
            if let accessory { Image(systemName: accessory).font(.caption) }
        }
        .foregroundStyle(status.isFailure ? Color.red : .secondary)
        .frame(minHeight: 44).contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct TimelineFold<Content: View>: View {
    let id: String
    let title: String
    let symbol: String
    let status: V2TimelineItemStatus
    let disclosures: TimelineDisclosureState
    @ViewBuilder var content: () -> Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.18)) { disclosures.toggle(id) }
            } label: { TimelineMarkerRow(title: title, symbol: symbol, status: status, expanded: disclosures.isExpanded(id)) }
            .buttonStyle(.plain).accessibilityValue(disclosures.isExpanded(id) ? "已展开" : "已折叠")
            if disclosures.isExpanded(id) { content() }
        }
    }
}

private struct TimelineFileChangeView: View {
    let change: TimelineFileChange
    let onFile: (String) -> Void
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "doc.text").foregroundStyle(.secondary)
                Text(change.action.label).font(.caption2).padding(5).background(.quaternary, in: .rect(cornerRadius: 5))
                Button { if let path = change.path { onFile(path) } } label: {
                    Text(change.displayPath).font(.system(.caption, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain).disabled(change.path == nil).accessibilityHint("在 Web 预览中打开文件")
                Image(systemName: "arrow.up.right").font(.caption2).foregroundStyle(.secondary)
            }.padding(.horizontal, 12).frame(minHeight: 44).background(.quaternary.opacity(0.4))
            if let code = change.diff ?? change.code { TimelineCodePanel(label: change.diff == nil ? "code" : "diff", code: code, isDiff: change.diff != nil) }
        }.background(Color(uiColor: .secondarySystemBackground))
    }
}

struct TimelineCodePanel: View {
    let label: String
    let code: String
    var isDiff = false
    @State private var copied = false
    @ScaledMetric(relativeTo: .caption) private var rowHeight: CGFloat = 19
    private var displayCode: String { String(code.prefix(200_000)) }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(label).font(.system(.caption, design: .monospaced))
                Spacer()
                Button {
                    UIPasteboard.general.string = code; copied = true
                } label: { Image(systemName: copied ? "checkmark" : "document.on.document").frame(width: 44, height: 44) }
                .buttonStyle(.plain).accessibilityLabel(copied ? "已复制" : "复制 \(label)")
                .task(id: copied) { if copied { try? await Task.sleep(for: .seconds(2)); copied = false } }
            }.padding(.leading, 12).foregroundStyle(.secondary).background(.quaternary.opacity(0.3))
            ScrollView([.horizontal, .vertical]) {
                if isDiff {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(TimelineDiff(displayCode).lines) { line in
                            HStack(alignment: .top, spacing: 8) {
                                Text(line.sign).frame(width: 10)
                                Text(line.oldLine.map(String.init) ?? "").frame(width: 34, alignment: .trailing)
                                Text(line.newLine.map(String.init) ?? "").frame(width: 34, alignment: .trailing)
                                Text(line.text.isEmpty ? " " : line.text).textSelection(.enabled).fixedSize(horizontal: true, vertical: false)
                                Spacer(minLength: 0)
                            }
                            .font(.system(.caption, design: .monospaced)).monospacedDigit()
                            .padding(.horizontal, 12).frame(minHeight: rowHeight)
                            .foregroundStyle(diffColor(line.kind)).background(diffColor(line.kind).opacity(line.kind == .add || line.kind == .delete ? 0.09 : 0))
                        }
                    }.padding(.vertical, 8).fixedSize(horizontal: true, vertical: false)
                } else {
                    Text(displayCode).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false).padding(12).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(height: min(320, max(76, CGFloat(displayCode.components(separatedBy: "\n").count) * rowHeight + 24)))
            if displayCode.count < code.count { Text("预览已截断，复制可获取完整内容").font(.caption).foregroundStyle(.secondary).padding(8) }
        }.background(Color(uiColor: .secondarySystemBackground))
    }
    private func diffColor(_ kind: TimelineDiff.Line.Kind) -> Color {
        switch kind { case .add: .green; case .delete: .red; case .hunk, .file, .annotation: .secondary; case .context: .primary }
    }
}
