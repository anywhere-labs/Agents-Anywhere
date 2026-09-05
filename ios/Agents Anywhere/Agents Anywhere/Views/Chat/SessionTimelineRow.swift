import SwiftUI
import UIKit

struct SessionTimelineRow: View {
    let row: ChatTimelineRowModel
    let onAttachment: (V2AttachmentContent) -> Void
    var cwd: String?
    let disclosures: TimelineDisclosureState
    let onFile: (String) -> Void
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
            default:
                SessionTimelineEventView(row: row, cwd: cwd, disclosures: disclosures, onFile: onFile)

            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            Button("复制内容", systemImage: "document.on.document") {
                UIPasteboard.general.string = row.text.isEmpty ? row.value.raw["content"]?.formattedJSON : row.text
            }
            Button("复制条目 ID", systemImage: "number") { UIPasteboard.general.string = row.id }
            Button("复制原始 JSON", systemImage: "curlybraces") { UIPasteboard.general.string = row.value.raw.formattedJSON }
        }
    }

    private var markdown: some View {
        ChatMarkdownView(text: row.text, isStreaming: row.isRevealing, resolvesFileReferences: true)
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
    private func attachment(_ file: V2AttachmentContent) -> some View {
        Button { onAttachment(file) } label: { Label(file.name ?? "附件", systemImage: "doc") }
            .disabled(file.fileId == nil)
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
