import Foundation

nonisolated struct V2AttachmentReference: Codable, Identifiable, Hashable {
    let fileId: V2AttachmentID
    let sessionId: V2SessionID
    let name: String
    let mediaType: String
    let size: Int
    let sha256: String
    let createdAt: String
    let downloadUrl: String
    let openUrl: String

    var id: V2AttachmentID { fileId }
}

struct V2AttachmentDownload: Decodable, Hashable {
    let fileId: V2AttachmentID
    let sessionId: V2SessionID
    let path: String
    let name: String
    let size: Int
    let sha256: String
    let contentBase64: String
    let createdAt: String
    let serverTime: String
}

struct V2AttachmentContent: Hashable {
    let fileId: V2AttachmentID?
    let name: String?
    let mediaType: String?
    let size: Int?
    let openUrl: String?
    let downloadUrl: String?
    let raw: JSONValue

    nonisolated init(rawContent: JSONValue) {
        fileId = rawContent["fileId"]?.stringValue ?? rawContent["id"]?.stringValue
        name = rawContent["name"]?.stringValue
        mediaType = rawContent["mediaType"]?.stringValue ?? rawContent["mimeType"]?.stringValue
        size = rawContent["size"]?.v2IntValue
        openUrl = rawContent["openUrl"]?.stringValue
        downloadUrl = rawContent["downloadUrl"]?.stringValue
        raw = rawContent
    }
}

struct V2AttachmentUploadResponse: Decodable, Hashable {
    let attachments: [V2AttachmentReference]
    let serverTime: String
}

private extension JSONValue {
    nonisolated var v2IntValue: Int? {
        switch self {
        case let .number(value):
            return Int(value)
        case let .string(value):
            return Int(value)
        default:
            return nil
        }
    }
}

/// create-and-start returns timeline attachment metadata, not the upload DTO.
struct V2CreatedAttachment: Codable, Hashable {
    let fileId: String
    let name: String
    let mediaType: String
    let size: Int
    let sha256: String

    func reference(sessionID: String) -> V2AttachmentReference {
        // These are the same session-scoped routes returned by the upload API.
        let path = "/api/v2/sessions/" + sessionID.v2URLPathComponentEncoded + "/attachments/" + fileId.v2URLPathComponentEncoded
        return .init(fileId: fileId, sessionId: sessionID, name: name, mediaType: mediaType, size: size,
            sha256: sha256, createdAt: "", downloadUrl: path, openUrl: path + "/open")
    }
}
