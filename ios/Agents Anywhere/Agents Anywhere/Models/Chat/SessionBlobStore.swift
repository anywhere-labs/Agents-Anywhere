import Foundation
import Observation

/// Loads the full content behind timeline `blobRefs` on request and keeps a
/// bounded in-memory copy, so folding a row and opening it again does not
/// download the bytes a second time.
@MainActor @Observable final class SessionBlobStore {
    enum State: Equatable {
        case idle
        case loading
        case text(String)
        case image(Data)
        case failed(String)
    }

    /// Largest text shown in the timeline; larger text opens as a file.
    static let inlineTextLimit = 4 * 1024 * 1024
    /// Largest image decoded in the timeline; larger images open as a file.
    static let inlineImageLimit = 20 * 1024 * 1024
    /// Largest blob opened as a file.
    static let fileLimit = 64 * 1024 * 1024

    @Observable fileprivate final class Entry {
        var state: State = .idle
    }

    typealias Loader = (String, Int) async throws -> V2SessionBlob

    @ObservationIgnored private var entries: [String: Entry] = [:]
    @ObservationIgnored private var order: [String] = []
    @ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private let loader: Loader
    @ObservationIgnored private let byteLimit: Int

    init(byteLimit: Int = 48 * 1024 * 1024, loader: @escaping Loader) {
        self.byteLimit = byteLimit
        self.loader = loader
    }

    func state(_ blobId: String) -> State { entry(blobId).state }

    /// Whether the ref can be shown in place in the timeline, by kind and size.
    static func showsInline(_ ref: V2TimelineBlobRef, kind: V2TimelineBlobRef.Kind) -> Bool {
        switch kind {
        case .text: ref.bytes <= inlineTextLimit
        case .image: ref.bytes <= inlineImageLimit
        case .audio, .other: false
        }
    }

    /// Starts loading `ref` for inline display; a running or finished load is kept.
    func load(_ ref: V2TimelineBlobRef, kind: V2TimelineBlobRef.Kind) {
        let value = entry(ref.blobId)
        switch value.state {
        case .loading, .text, .image: return
        case .idle, .failed: break
        }
        guard Self.showsInline(ref, kind: kind) else { return }
        value.state = .loading
        let limit = kind == .text ? Self.inlineTextLimit : Self.inlineImageLimit
        tasks[ref.blobId] = Task { [weak self, loader] in
            let next: State
            do {
                let blob = try await loader(ref.blobId, limit)
                if kind == .text {
                    next = .text(String(decoding: blob.data, as: UTF8.self))
                } else {
                    next = .image(blob.data)
                }
            } catch is CancellationError {
                next = .idle
            } catch {
                next = .failed(SessionBlobErrorText.text(error))
            }
            guard let self else { return }
            tasks[ref.blobId] = nil
            entry(ref.blobId).state = next
            trim()
        }
    }

    /// Loaded full text for the ref of `item` whose path is `pointer`.
    func loadedText(for item: V2TimelineItem, at pointer: String) -> String? {
        guard let ref = item.blobRefs.first(where: { $0.path == pointer }),
              case let .text(text) = entries[ref.blobId]?.state else { return nil }
        return text
    }

    func cancelAll() {
        tasks.values.forEach { $0.cancel() }
        tasks = [:]
    }

    private func entry(_ key: String) -> Entry {
        if let value = entries[key] { return value }
        let value = Entry()
        entries[key] = value
        order.append(key)
        while order.count > 512 {
            let oldest = order.removeFirst()
            if tasks[oldest] == nil { entries.removeValue(forKey: oldest) } else { order.append(oldest); break }
        }
        return value
    }

    private func bytes(_ state: State) -> Int {
        switch state {
        case let .text(text): text.utf8.count
        case let .image(data): data.count
        default: 0
        }
    }

    /// Drops the oldest loaded content once the cache exceeds its byte budget.
    private func trim() {
        var total = entries.values.reduce(0) { $0 + bytes($1.state) }
        for key in order where total > byteLimit {
            guard let value = entries[key] else { continue }
            let size = bytes(value.state)
            if size > 0 { value.state = .idle; total -= size }
        }
    }
}

/// User-facing text for blob read failures.
nonisolated enum SessionBlobErrorText {
    static func text(_ error: Error) -> String {
        if let error = error as? HTTPError {
            switch error.serverCode {
            case "blob_not_found": return String(localized: "设备上已找不到这份内容。")
            case "connector_offline": return String(localized: "设备离线，暂时无法读取完整内容。")
            default: break
            }
            if error.statusCode == 404 { return String(localized: "这台设备不支持读取完整内容，请升级设备上的 Agents Anywhere。") }
        }
        return error.localizedDescription
    }
}

extension V2TimelineBlobRef {
    /// Attachment-shaped metadata so the existing file preview can open the bytes.
    func attachment(in content: JSONValue) -> V2AttachmentContent {
        var fields: [String: JSONValue] = [
            "fileId": .string(blobId), "name": .string(suggestedFileName(in: content)),
            "size": .number(Double(bytes)), "blobRef": .bool(true),
        ]
        if let type = effectiveMediaType(in: content) { fields["mediaType"] = .string(type) }
        return V2AttachmentContent(rawContent: .object(fields))
    }
}

extension V2AttachmentContent {
    /// Metadata built from a timeline blob reference rather than an uploaded attachment.
    var isTimelineBlob: Bool { raw["blobRef"] == .bool(true) }
}
