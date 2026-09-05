import SwiftUI
import UIKit

struct SessionTimelineRow: View {
    let row: ChatTimelineRowModel
    let onAttachment: (V2AttachmentContent) -> Void
    @State private var copied = false
    @ScaledMetric(relativeTo: .body) private var lineHeight: CGFloat = 22

    var body: some View {
        Group {
            switch row.value.content {
            case let .message(message):
                if row.value.role == .user {
                    UserMessageBubble(text: row.text, attachments: message.attachments, onAttachment: onAttachment)
                } else {
                    VStack(alignment: .leading, spacing: 14) {
                        markdown
                        ForEach(Array(message.attachments.enumerated()), id: \.offset) { _, file in attachment(file) }
                        if row.value.isStreamingText {
                            Group {
                                if row.text.isEmpty { Text("正在思考").font(.subheadline).foregroundStyle(.secondary) }
                                else { Color.clear.accessibilityHidden(true) }
                            }.frame(height: 40, alignment: .leading)
                        } else {
                            if row.value.status == .interrupted || row.value.status == .cancelled {
                                Text("已停止生成").font(.caption).foregroundStyle(.secondary)
                            }
                            if row.value.status == .failed { Text("生成未完成").font(.caption).foregroundStyle(.secondary) }
                            messageActions
                        }
                    }
                }
            case .reasoning:
                DisclosureGroup {
                    markdown.padding(.top, 8)
                } label: {
                    Label(row.value.isStreamingText ? "正在思考" : "思考过程", systemImage: "brain")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
            case let .tool(tool):
                DisclosureGroup {
                    if let input = tool.input { jsonBlock(input, title: "输入") }
                    if let output = tool.output { jsonBlock(output, title: "输出") }
                } label: {
                    eventLabel(tool.name ?? "工具调用", icon: "wrench.and.screwdriver")
                }.modifier(TimelineEventSurface())
            case let .fileChange(change):
                DisclosureGroup {
                    if let patch = change.patch { Text(patch).font(.system(.footnote, design: .monospaced)).textSelection(.enabled) }
                    ForEach(Array(change.changes.enumerated()), id: \.offset) { _, value in jsonBlock(value, title: "变更") }
                } label: { eventLabel(change.path ?? "文件变更", icon: "doc.badge.gearshape") }
                .modifier(TimelineEventSurface())
            case let .attachment(file): attachment(file)
            case let .artifact(artifact):
                DisclosureGroup {
                    if let raw = artifact.url, let url = URL(string: raw), ["https", "http"].contains(url.scheme ?? "") {
                        Link("打开产物", destination: url)
                    }
                    jsonBlock(artifact.raw, title: "详情")
                } label: { eventLabel(artifact.title ?? "产物", icon: "doc.richtext") }
                .modifier(TimelineEventSurface())
            case let .marker(marker):
                if row.value.isAssistantText {
                    DisclosureGroup { markdown.padding(.top, 8) } label: {
                        Label(row.value.isStreamingText ? "正在思考" : "思考过程", systemImage: "brain")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        Label(marker.title, systemImage: "info.circle").font(.subheadline).foregroundStyle(.secondary)
                        if let subtitle = marker.subtitle { Text(subtitle).font(.footnote).foregroundStyle(.secondary) }
                    }
                }
            case let .unknown(value):
                DisclosureGroup("事件详情") { jsonBlock(value, title: "") }.modifier(TimelineEventSurface())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var markdown: some View {
        ChatMarkdownView(text: row.text, isStreaming: row.isRevealing)
            .id(row.layoutGeneration)
            .frame(minHeight: row.value.isStreamingText ? lineHeight : nil, alignment: .topLeading)
    }
    private var messageActions: some View {
        HStack(spacing: 2) {
            Button {
                UIPasteboard.general.string = row.text; copied = true
            } label: { Image(systemName: copied ? "checkmark" : "document.on.document").frame(width: 44, height: 40) }
            .accessibilityLabel(copied ? "已复制" : "复制回复")
            .task(id: copied) {
                guard copied else { return }
                do { try await Task.sleep(for: .seconds(2)); copied = false } catch {}
            }
            ShareLink(item: row.text) { Image(systemName: "square.and.arrow.up").frame(width: 44, height: 40) }
                .accessibilityLabel("分享回复")
        }
        .disabled(row.text.isEmpty)
        .buttonStyle(.plain).font(.system(size: 15)).foregroundStyle(.secondary).padding(.leading, -10)
    }
    private func eventLabel(_ title: String, icon: String) -> some View {
        HStack {
            Label(title, systemImage: icon).lineLimit(2)
            Spacer()
            Text(row.value.status.rawValue).font(.caption).foregroundStyle(.secondary)
        }.font(.subheadline)
    }
    private func jsonBlock(_ value: JSONValue, title: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if !title.isEmpty { Text(title).font(.caption).foregroundStyle(.secondary) }
            Text(value.readableText).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
        }.padding(.vertical, 6)
    }
    private func attachment(_ file: V2AttachmentContent) -> some View {
        Button { onAttachment(file) } label: { Label(file.name ?? "附件", systemImage: "doc") }
            .disabled(file.fileId == nil)
    }
}

private struct TimelineEventSurface: ViewModifier {
    func body(content: Content) -> some View {
        content.padding(16).background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 18))
    }
}

struct UserMessageBubble: View {
    let text: String
    var attachments: [V2AttachmentContent] = []
    var onAttachment: (V2AttachmentContent) -> Void = { _ in }
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(attachments.enumerated()), id: \.offset) { _, file in
                    Button { onAttachment(file) } label: {
                        Label(file.name ?? "附件", systemImage: file.mediaType?.hasPrefix("image/") == true ? "photo" : "doc.text")
                            .font(.subheadline).lineLimit(2)
                    }.disabled(file.fileId == nil)
                }
                if !text.isEmpty { Text(text).font(.body).textSelection(.enabled) }
            }
            .padding(.horizontal, 17).padding(.vertical, 12)
            .background(colorScheme == .dark ? Color(white: 0.13) : Color(white: 0.94), in: .rect(cornerRadius: 24))
        }
    }
}

struct PendingMessageRow: View {
    let pending: V2PendingMessage
    let onDismiss: () -> Void
    @State private var confirmsDismiss = false
    var body: some View {
        VStack(alignment: .trailing, spacing: 7) {
            UserMessageBubble(text: pending.content)
            if !pending.attachmentIDs.isEmpty { Text("\(pending.attachmentIDs.count) 个附件").font(.caption).foregroundStyle(.secondary) }
            switch pending.delivery {
            case .sending: Text("正在发送…").font(.caption).foregroundStyle(.secondary)
            case .accepted: Text("已提交，等待会话确认").font(.caption).foregroundStyle(.secondary)
            case .confirmed: EmptyView()
            case .uncertain:
                Text("发送结果未确认，草稿已保留").font(.caption).foregroundStyle(.secondary)
                Button("处理未确认的发送") { confirmsDismiss = true }.font(.caption)
            case let .rejected(error):
                Text(error.message).font(.caption).foregroundStyle(.secondary)
                Button("移除此发送记录", action: onDismiss).font(.caption)
            }
        }
        .confirmationDialog("请先检查会话是否已收到消息。移除记录后再次发送可能产生重复消息。", isPresented: $confirmsDismiss, titleVisibility: .visible) {
            Button("已检查，移除记录", action: onDismiss)
            Button("取消", role: .cancel) {}
        }
    }
}

extension JSONValue {
    var readableText: String {
        if case let .string(value) = self { return value }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
}
