import SwiftUI

/// Messages waiting on the Server for this session, shown above the composer.
struct SessionMessageQueuePanel: View {
    let chat: SessionChatModel
    @State private var expanded = false
    @State private var editingID: String?
    @State private var editingText = ""

    private static let collapsedCount = 2

    var body: some View {
        if let queue = chat.session.queue, !queue.items.isEmpty {
            let items = queue.items
            let pause = queue.pause(status: chat.session.runtime.state?.status)
            let canControl = chat.canManageQueue
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Image(systemName: "tray.full").accessibilityHidden(true)
                    Text(String(localized: "\(items.count) 条消息排队中")).font(.caption.weight(.semibold))
                    Spacer(minLength: 0)
                    if pause == .error, canControl {
                        Button(String(localized: "继续发送")) { Task { await chat.queueAction(.resume) } }
                            .font(.caption)
                    }
                    if canControl, items.count > 1 {
                        Button(String(localized: "全部清空")) { Task { await chat.queueAction(.clear) } }
                            .font(.caption)
                    }
                }
                switch pause {
                case .error:
                    Text(String(localized: "上一个任务出错，排队消息已暂停")).font(.caption).foregroundStyle(.secondary)
                case .failed:
                    Text(String(localized: "第一条消息发送失败，后面的消息不会发出")).font(.caption).foregroundStyle(.red)
                case nil:
                    EmptyView()
                }
                ForEach(expanded ? items : Array(items.prefix(Self.collapsedCount))) { item in
                    row(item, canControl: canControl)
                }
                if items.count > Self.collapsedCount {
                    Button(expanded ? String(localized: "收起") : String(localized: "显示全部 \(items.count) 条")) { expanded.toggle() }
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            .disabled(chat.queueBusyID != nil)
            .padding(.horizontal, 16).padding(.vertical, 8)
            .accessibilityIdentifier("chat.queue")
            .alert(String(localized: "编辑排队消息"), isPresented: Binding(get: { editingID != nil }, set: { if !$0 { editingID = nil } })) {
                TextField(String(localized: "编辑排队消息"), text: $editingText, axis: .vertical)
                Button(String(localized: "保存")) {
                    let text = editingText.trimmingCharacters(in: .whitespacesAndNewlines)
                    if let id = editingID, !text.isEmpty { Task { await chat.queueAction(.edit(messageId: id, content: text)) } }
                    editingID = nil
                }
                Button(String(localized: "取消"), role: .cancel) { editingID = nil }
            }
        }
    }

    @ViewBuilder private func row(_ item: V2SessionQueueItem, canControl: Bool) -> some View {
        let failed = item.status == .failed
        HStack(spacing: 8) {
            Group {
                if item.status == .sending || chat.queueBusyID == item.id {
                    ProgressView().controlSize(.mini)
                } else if failed {
                    Image(systemName: "exclamationmark.circle")
                } else {
                    Text("#\(item.position)").monospacedDigit()
                }
            }
            .font(.caption).foregroundStyle(failed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
            Text(item.content.isEmpty ? String(localized: "\(item.attachments?.count ?? 0) 个附件") : item.content)
                .font(.subheadline).lineLimit(1)
                .foregroundStyle(failed ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(statusText(item)).font(.caption).foregroundStyle(failed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
            if canControl, item.isEditable {
                Menu {
                    if failed {
                        Button(String(localized: "重试"), systemImage: "arrow.clockwise") {
                            Task { await chat.queueAction(.retry(messageId: item.id)) }
                        }
                    } else if chat.session.runtime.allows("session.interrupt"), !item.interruptRequested {
                        Button(String(localized: "立即发送（打断当前任务）"), systemImage: "paperplane") {
                            Task { await chat.queueAction(.sendNow(messageId: item.id)) }
                        }
                    }
                    Button(String(localized: "编辑"), systemImage: "pencil") {
                        editingText = item.content; editingID = item.id
                    }
                    Button(String(localized: "删除"), systemImage: "trash", role: .destructive) {
                        Task { await chat.queueAction(.delete(messageId: item.id)) }
                    }
                } label: {
                    Image(systemName: "ellipsis").frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .accessibilityLabel(String(localized: "排队消息操作"))
            }
        }
        .help(failed ? item.error?.message ?? item.content : item.content)
    }

    private func statusText(_ item: V2SessionQueueItem) -> String {
        switch item.status {
        case .sending: String(localized: "发送中")
        case .failed: String(localized: "发送失败")
        case .queued, .unknown: item.interruptRequested ? String(localized: "等待打断") : String(localized: "排队中")
        }
    }
}
