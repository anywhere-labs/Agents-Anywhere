import Foundation

struct V2WorkspaceFilesListRequest: Encodable, Hashable {
    let root: String
    let path: String
}

struct V2WorkspaceFileReadRequest: Encodable, Hashable {
    let path: String
}

struct V2WorkspaceDirectoryResponse: Decodable, Hashable {
    let ok: Bool
    let result: V2WorkspaceDirectory?
    let error: V2RuntimeError?
}

struct V2WorkspaceDirectory: Decodable, Hashable {
    let path: String
    let entries: [V2WorkspaceEntry]
    let truncated: Bool?
}

struct V2WorkspaceEntry: Decodable, Identifiable, Hashable {
    let name: String
    let path: String
    let type: String
    let size: Int?
    let modifiedAt: String?

    var id: String { path }
    var isDirectory: Bool { type == "directory" }
    var isFile: Bool { type == "file" }
}

struct V2WorkspaceFilePreviewToken: Decodable, Hashable {
    let previewToken: String
    let expiresAt: String
    let serverTime: String
}

struct V2WorkspaceFileReadResponse: Decodable {
    let ok: Bool
    let result: V2WorkspaceFileTransfer?
    let error: V2RuntimeError?
}

struct V2WorkspaceFileTransfer: Decodable {
    let name: String
    let size: Int64
    let downloadUrl: String
}

struct V2WorkspaceTextRequest: Encodable, Hashable {
    let path: String
    var maxBytes: Int = 1_048_576
}

struct V2WorkspaceTextResponse: Decodable, Hashable {
    let path: String
    let name: String
    let size: Int
    let sha256: String
    let encoding: String
    let content: String
    let truncated: Bool
    let binary: Bool
    let serverTime: String
}
