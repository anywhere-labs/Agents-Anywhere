import SwiftUI
import UIKit

struct SessionTimelineRow: View {
    let row: ChatTimelineRowModel
    let chat: SessionChatModel
    let onAttachment: (V2AttachmentContent) -> Void
    var cwd: String?
    let disclosures: TimelineDisclosureState
    let onFile: (String) -> Void
    @ScaledMetric(relativeTo: .body) private var lineHeight: CGFloat = 22

    var body: some View {
        Group {
            switch row.value.content {
            case let .message(message):
                let files = chat.session.attachmentPreviews.resolve(message.attachments, clientID: row.value.source["clientMessageId"]?.stringValue)
                if row.value.role == .user {
                    UserMessageBubble(text: row.text, attachments: files, onAttachment: onAttachment, loadThumbnail: chat.thumbnail)
                } else {
                    VStack(alignment: .leading, spacing: 14) {
                        markdown
                        ChatMessageAttachments(files: files, onOpen: onAttachment, loadThumbnail: chat.thumbnail, alignment: .leading)
                        if row.value.isStreamingText && row.text.isEmpty {
                            Text("正在思考").font(.subheadline).foregroundStyle(.secondary)
                        } else if !row.value.isStreamingText {
                            if row.value.status == .interrupted || row.value.status == .cancelled {
                                Text("已停止生成").font(.caption).foregroundStyle(.secondary)
                            }
                            if row.value.status == .failed { Text("生成未完成").font(.caption).foregroundStyle(.secondary) }
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
}

struct UserMessageBubble: View {
    let text: String
    var attachments: [ChatMessageAttachment] = []
    var onAttachment: (V2AttachmentContent) -> Void = { _ in }
    var loadThumbnail: (V2AttachmentContent) async throws -> Data? = { _ in nil }
    var isPending = false
    var onDeliveryIssue: (() -> Void)?
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 8) {
                if !attachments.isEmpty {
                    ChatMessageAttachments(files: attachments, onOpen: onAttachment, loadThumbnail: loadThumbnail)
                }
                if !text.isEmpty {
                    Text(text).font(.body).textSelection(.enabled)
                        .padding(.horizontal, 17).padding(.vertical, 12)
                        .background(colorScheme == .dark ? Color(white: 0.13) : Color(white: 0.94), in: .rect(cornerRadius: 24))
                }
            }
            .overlay(alignment: .bottomLeading) {
                // Delivery state occupies the existing leading gutter, so the
                // echo never changes text wrapping or attachment width.
                if isPending {
                    ProgressView().progressViewStyle(.circular).controlSize(.small)
                        .frame(width: 18, height: 44).offset(x: -26).accessibilityLabel("正在发送消息")
                } else if let onDeliveryIssue {
                    Button(action: onDeliveryIssue) {
                        Image(systemName: "exclamationmark.circle").foregroundStyle(.red).frame(width: 24, height: 44)
                    }.buttonStyle(.plain).offset(x: -30).accessibilityLabel("查看发送问题")
                }
            }
        }
    }
}

struct PendingMessageRow: View {
    let pending: V2PendingMessage
    let chat: SessionChatModel
    let onAttachment: (V2AttachmentContent) -> Void
    let onDismiss: () -> Void
    @State private var confirmsDismiss = false
    var body: some View {
        UserMessageBubble(text: pending.content,
            attachments: chat.session.attachmentPreviews.resolve(pending.attachments.map(\.content), clientID: pending.id),
            onAttachment: onAttachment, loadThumbnail: chat.thumbnail, isPending: pending.delivery == .sending || pending.delivery == .accepted,
            onDeliveryIssue: deliveryIssue == nil ? nil : { confirmsDismiss = true })
        .confirmationDialog(deliveryIssue ?? "", isPresented: $confirmsDismiss, titleVisibility: .visible) {
            Button("移除此发送记录", action: onDismiss)
            Button("取消", role: .cancel) {}
        }
    }
    private var deliveryIssue: String? {
        switch pending.delivery {
        case .uncertain: "发送结果尚未确认，草稿已保留。请先检查会话是否已收到消息；移除记录后再次发送可能产生重复消息。"
        case let .rejected(error): error.message
        default: nil
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
