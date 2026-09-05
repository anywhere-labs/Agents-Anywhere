import Foundation
import Observation

struct ChatMessageAttachment: Identifiable, Equatable {
    let id: String
    let content: V2AttachmentContent
    let previewData: Data?
}

/// Session/account-scoped metadata and small previews survive the optimistic
/// bubble's replacement. Full uploaded files are never retained in this cache.
@MainActor @Observable final class ChatAttachmentStore {
    @Observable fileprivate final class Entry {
        var content: V2AttachmentContent?
        var previewData: Data?
    }
    @ObservationIgnored private var entries: [String: Entry] = [:]
    @ObservationIgnored private var order: [String] = []
    @ObservationIgnored private var sent: [String: [V2AttachmentContent]] = [:]
    @ObservationIgnored private var sentOrder: [String] = []
    @ObservationIgnored private let byteLimit: Int
    init(byteLimit: Int = 16 * 1024 * 1024) { self.byteLimit = byteLimit }

    func remember(_ attachments: [ChatAttachment], clientID: String) {
        let contents = attachments.map(\.content)
        sent[clientID] = contents
        sentOrder.removeAll { $0 == clientID }; sentOrder.append(clientID)
        while sentOrder.count > 128 { sent.removeValue(forKey: sentOrder.removeFirst()) }
        for (attachment, content) in zip(attachments, contents) {
            let value = entry(content.cacheKey)
            value.content = content
            value.previewData = attachment.previewData
        }
        trim()
    }

    func resolve(_ contents: [V2AttachmentContent], clientID: String? = nil) -> [ChatMessageAttachment] {
        let fallback = clientID.flatMap { sent[$0] } ?? []
        return (contents.isEmpty ? fallback : contents).enumerated().map { index, content in
            // Correlate by file ID; reordered files must never inherit the wrong image.
            let saved = content.fileId.flatMap { entries[$0]?.content }
                ?? entries[content.cacheKey]?.content ?? fallback.first { $0.fileId == content.fileId && content.fileId != nil }
            let merged = saved.map { content.fillingMissingMetadata(from: $0) } ?? content
            let value = entry(merged.cacheKey)
            return ChatMessageAttachment(id: content.fileId ?? "attachment:\(index):\(content.cacheKey)", content: merged, previewData: value.previewData)
        }
    }

    func preview(for file: V2AttachmentContent) -> Data? { entry(file.cacheKey).previewData }
    func cache(_ data: Data, for file: V2AttachmentContent) {
        guard data.count <= byteLimit else { return }
        entry(file.cacheKey).previewData = data
        trim()
    }
    func clear() { entries = [:]; order = []; sent = [:]; sentOrder = [] }
    private func entry(_ key: String) -> Entry {
        order.removeAll { $0 == key }; order.append(key)
        if let value = entries[key] { return value }
        let value = Entry(); entries[key] = value
        while order.count > 256 { entries.removeValue(forKey: order.removeFirst()) }
        return value
    }
    private func trim() {
        var bytes = entries.values.reduce(0) { $0 + ($1.previewData?.count ?? 0) }
        for key in order where bytes > byteLimit {
            if let value = entries[key], let data = value.previewData { bytes -= data.count; value.previewData = nil }
        }
    }
}

extension V2AttachmentContent {
    var devicePath: String? { raw["path"]?.stringValue ?? raw["filePath"]?.stringValue }
    var root: String? { raw["root"]?.stringValue }
    var readsFromDevice: Bool { devicePath != nil && openUrl == nil && downloadUrl == nil }
    var isImage: Bool {
        if mediaType?.hasPrefix("image/") == true { return true }
        let suffix = ((name ?? devicePath ?? "") as NSString).pathExtension.lowercased()
        return ["png", "jpg", "jpeg", "heic", "heif", "gif", "webp", "tiff", "bmp"].contains(suffix)
    }
    var cacheKey: String { readsFromDevice ? "fs:\(root ?? ""):\(devicePath ?? ""):\(raw.hashValue)" : fileId ?? "raw:\(raw.hashValue)" }
    func fillingMissingMetadata(from local: V2AttachmentContent) -> V2AttachmentContent {
        guard case var .object(fields) = local.raw, case let .object(server) = raw else { return self }
        for (key, value) in server where value != .null { fields[key] = value }
        return V2AttachmentContent(rawContent: .object(fields))
    }
}

extension ChatAttachment {
    var content: V2AttachmentContent {
        var fields: [String: JSONValue] = ["fileId": .string(uploaded?.fileId ?? "local:\(id)"),
            "name": .string(uploaded?.name ?? name), "mediaType": .string(uploaded?.mediaType ?? mediaType),
            "size": .number(Double(uploaded?.size ?? data.count))]
        if let uploaded { fields["openUrl"] = .string(uploaded.openUrl); fields["downloadUrl"] = .string(uploaded.downloadUrl) }
        return V2AttachmentContent(rawContent: .object(fields))
    }
}
