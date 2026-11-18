import Foundation
import UniformTypeIdentifiers

/// RFC 6901 JSON pointer into a JSON tree.
nonisolated enum JSONPointer {
    /// Reference tokens of `pointer`, unescaped; nil when it is not a valid pointer.
    /// The empty pointer refers to the whole document and has no tokens.
    static func tokens(_ pointer: String) -> [String]? {
        if pointer.isEmpty { return [] }
        guard pointer.hasPrefix("/") else { return nil }
        var tokens: [String] = []
        for raw in pointer.dropFirst().split(separator: "/", omittingEmptySubsequences: false) {
            var token = ""
            var index = raw.startIndex
            while index < raw.endIndex {
                let character = raw[index]
                if character == "~" {
                    let next = raw.index(after: index)
                    guard next < raw.endIndex else { return nil }
                    switch raw[next] {
                    case "0": token.append("~")
                    case "1": token.append("/")
                    default: return nil
                    }
                    index = raw.index(after: next)
                } else {
                    token.append(character)
                    index = raw.index(after: index)
                }
            }
            tokens.append(token)
        }
        return tokens
    }

    /// The value `pointer` refers to inside `root`, or nil when it does not exist.
    static func resolve(_ pointer: String, in root: JSONValue) -> JSONValue? {
        guard let tokens = tokens(pointer) else { return nil }
        return resolve(tokens: tokens[...], in: root)
    }

    static func resolve(tokens: ArraySlice<String>, in root: JSONValue) -> JSONValue? {
        var current = root
        for token in tokens {
            switch current {
            case let .object(fields):
                guard let value = fields[token] else { return nil }
                current = value
            case let .array(values):
                // Array indexes are decimal without leading zeros ("0", "12").
                guard let index = Int(token), String(index) == token, values.indices.contains(index) else { return nil }
                current = values[index]
            default:
                return nil
            }
        }
        return current
    }
}

/// A large field of a timeline item that the device moved into its blob store.
/// `path` points into the item's `content`; the item keeps a preview or placeholder there.
nonisolated struct V2TimelineBlobRef: Hashable, Identifiable, Sendable {
    enum Kind: Hashable, Sendable { case text, image, audio, other }

    let path: String
    let blobId: String
    let bytes: Int
    let mediaType: String?

    var id: String { blobId + "|" + path }

    init(path: String, blobId: String, bytes: Int, mediaType: String?) {
        self.path = path; self.blobId = blobId; self.bytes = bytes; self.mediaType = mediaType
    }

    init?(json: JSONValue) {
        guard let path = json["path"]?.stringValue, JSONPointer.tokens(path) != nil,
              case let .string(blobId)? = json["blobId"], !blobId.isEmpty else { return nil }
        let bytes: Int
        switch json["bytes"] {
        case let .number(value)? where value >= 0 && value.rounded() == value: bytes = Int(value)
        default: return nil
        }
        let mediaType: String?
        if case let .string(value)? = json["mediaType"], !value.isEmpty { mediaType = value } else { mediaType = nil }
        self.init(path: path, blobId: blobId, bytes: bytes, mediaType: mediaType)
    }

    /// Valid references of an item's `blobRefs`; an absent or malformed list yields none.
    static func list(_ value: JSONValue?) -> [V2TimelineBlobRef] {
        guard case let .array(values)? = value else { return [] }
        return values.compactMap(V2TimelineBlobRef.init(json:))
    }

    /// The media block that held a removed `data`/`blob` key, such as `{type: "image", mimeType, omitted}`.
    func mediaBlock(in content: JSONValue) -> JSONValue? {
        guard let tokens = JSONPointer.tokens(path), let last = tokens.last, ["data", "blob"].contains(last) else { return nil }
        guard let parent = JSONPointer.resolve(tokens: tokens.dropLast(), in: content), case .object = parent else { return nil }
        return parent
    }

    /// The declared media type, else the one of the media block it was cut from.
    func effectiveMediaType(in content: JSONValue) -> String? {
        if let mediaType { return mediaType }
        let block = mediaBlock(in: content)
        return block?["mimeType"]?.stringValue ?? block?["mediaType"]?.stringValue
    }

    func kind(in content: JSONValue) -> Kind {
        let type = effectiveMediaType(in: content)?.lowercased() ?? ""
        if type.hasPrefix("text/") { return .text }
        if type.hasPrefix("image/") { return .image }
        if type.hasPrefix("audio/") { return .audio }
        switch mediaBlock(in: content)?["type"]?.stringValue {
        case "image": return .image
        case "audio": return .audio
        default: return .other
        }
    }

    /// The placeholder the device left in place of the field, if any.
    func placeholder(in content: JSONValue) -> String? {
        if let block = mediaBlock(in: content), case let .string(value)? = block["omitted"] { return value }
        if case let .string(value)? = JSONPointer.resolve(path, in: content), kind(in: content) != .text { return value }
        return nil
    }

    /// A readable label for the field: the media block type, else the last non-index token.
    func label(in content: JSONValue) -> String {
        if let type = mediaBlock(in: content)?["type"]?.stringValue, !type.isEmpty { return type }
        let tokens = JSONPointer.tokens(path) ?? []
        return tokens.last { !$0.isEmpty && Int($0) == nil } ?? "content"
    }

    /// A file name for opening the bytes outside the timeline.
    func suggestedFileName(in content: JSONValue) -> String {
        let base = label(in: content).replacingOccurrences(of: "/", with: "_")
        let type = effectiveMediaType(in: content)?.split(separator: ";").first.map {
            String($0).trimmingCharacters(in: .whitespaces)
        }
        let ext = type.flatMap { UTType(mimeType: $0)?.preferredFilenameExtension } ?? (kind(in: content) == .text ? "txt" : nil)
        return ext.map { base + "." + $0 } ?? base
    }
}

/// One chunk of `GET /sessions/{id}/blobs/{blobRef}`.
nonisolated struct V2SessionBlobChunk: Decodable, Hashable {
    let blobRef: String
    let name: String?
    let mediaType: String?
    let encoding: String
    let data: String
    let offset: Int
    let size: Int
    let eof: Bool
}

/// The complete bytes of a device blob or a user-message attachment held by the device.
nonisolated struct V2SessionBlob: Hashable, Sendable {
    let blobRef: String
    let name: String?
    let mediaType: String?
    let data: Data
}

nonisolated extension V2TimelineItem {
    /// The item's `content` tree that blob reference paths point into.
    var contentTree: JSONValue { raw["content"].flatMap { $0 == .null ? nil : $0 } ?? .object([:]) }
}
