import Foundation

protocol V2AttachmentAPIProtocol {
    func upload(sessionId: V2SessionID, files: [HTTPUploadFile]) async throws -> V2AttachmentUploadResponse
    func download(sessionId: V2SessionID, fileId: V2AttachmentID) async throws -> V2AttachmentDownload
    /// One chunk of a device-held blob or attachment: `GET /sessions/{id}/blobs/{blobRef}`.
    func readBlobChunk(sessionId: V2SessionID, blobRef: String, offset: Int, length: Int) async throws -> V2SessionBlobChunk
    /// Whether this session's content currently travels through the secure channel.
    func usesSecureChannel(sessionId: V2SessionID) async throws -> Bool
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

    func readBlobChunk(sessionId: V2SessionID, blobRef: String, offset: Int, length: Int) async throws -> V2SessionBlobChunk {
        let request = HTTPRequest<EmptyRequestBody, V2SessionBlobChunk>(
            method: .get,
            path: "/sessions/\(sessionId.v2URLPathComponentEncoded)/blobs/\(blobRef.v2URLPathComponentEncoded)",
            queryItems: [URLQueryItem(name: "offset", value: String(offset)), URLQueryItem(name: "length", value: String(length))]
        )
        return try await transport.send(request)
    }

    func usesSecureChannel(sessionId: V2SessionID) async throws -> Bool {
        guard let routing = transport as? E2EERoutingHTTPTransport else { return false }
        if case .encrypted = try await routing.sessionRoute(sessionId) { return true }
        return false
    }
}
