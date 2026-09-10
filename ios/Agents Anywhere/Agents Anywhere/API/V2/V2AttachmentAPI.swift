import Foundation

protocol V2AttachmentAPIProtocol {
    func upload(sessionId: V2SessionID, files: [HTTPUploadFile]) async throws -> V2AttachmentUploadResponse
    func download(sessionId: V2SessionID, fileId: V2AttachmentID) async throws -> V2AttachmentDownload
}

struct V2AttachmentAPI: V2AttachmentAPIProtocol {
    let transport: any HTTPTransport

    func upload(
        sessionId: V2SessionID,
        files: [HTTPUploadFile]
    ) async throws -> V2AttachmentUploadResponse {
        let request = HTTPUploadRequest<V2AttachmentUploadResponse>(
            path: "/sessions/\(sessionId.v2URLPathComponentEncoded)/attachments",
            files: files
        )
        return try await transport.upload(request)
    }

    func download(sessionId: V2SessionID, fileId: V2AttachmentID) async throws -> V2AttachmentDownload {
        let request = HTTPRequest<EmptyRequestBody, V2AttachmentDownload>(
            method: .get,
            path: "/sessions/\(sessionId.v2URLPathComponentEncoded)/attachments/\(fileId.v2URLPathComponentEncoded)"
        )
        return try await transport.send(request)
    }
}
