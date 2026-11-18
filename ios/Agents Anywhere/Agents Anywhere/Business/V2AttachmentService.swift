import Foundation

struct V2AttachmentService {
    let attachmentAPI: any V2AttachmentAPIProtocol

    /// Uploads user-selected bytes to the server's session-scoped attachment store.
    func upload(
        sessionId: V2SessionID,
        attachments: [V2LocalAttachment]
    ) async throws -> [V2AttachmentReference] {
        if attachments.isEmpty { throw V2BusinessError.emptyAttachmentSelection }
        if attachments.count > 5 {
            throw V2BusinessError.tooManyAttachments(maximum: 5)
        }
        let files = try attachments.map { attachment in
            if attachment.data.isEmpty {
                throw V2BusinessError.emptyAttachment(name: attachment.name)
            }
            if attachment.data.count > 25 * 1024 * 1024 { throw V2BusinessError.attachmentTooLarge(name: attachment.name) }
            return HTTPUploadFile(
                fieldName: "files",
                fileName: attachment.name,
                mediaType: attachment.mediaType,
                data: attachment.data
            )
        }
        return try await attachmentAPI.upload(sessionId: sessionId, files: files).attachments
    }

    /// Largest chunk the device serves per blob read.
    static let blobChunkBytes = 4 * 1024 * 1024

    /// Attachment bytes. In an encrypted route the Server refuses its attachment
    /// routes, so the device-held copy is read through the blob route instead.
    func download(sessionId: V2SessionID, fileId: V2AttachmentID) async throws -> Data {
        if try await attachmentAPI.usesSecureChannel(sessionId: sessionId) {
            return try await readSessionBlob(sessionId: sessionId, blobRef: fileId, maxBytes: 64 * 1024 * 1024).data
        }
        let response = try await attachmentAPI.download(sessionId: sessionId, fileId: fileId)
        guard let data = Data(base64Encoded: response.contentBase64) else {
            throw HTTPError.decoding(message: String(localized: "The attachment content is not valid Base64 data."))
        }
        return data
    }

    /// Reads a device blob (`blob_…`) or a device-held attachment (`fileId`) chunk by chunk.
    /// Throws `blobTooLarge` before downloading when the blob exceeds `maxBytes`.
    func readSessionBlob(sessionId: V2SessionID, blobRef: String, maxBytes: Int) async throws -> V2SessionBlob {
        var data = Data()
        var offset = 0
        var total: Int?
        var name: String?
        var mediaType: String?
        while true {
            try Task.checkCancellation()
            let chunk = try await attachmentAPI.readBlobChunk(
                sessionId: sessionId, blobRef: blobRef, offset: offset, length: Self.blobChunkBytes)
            guard chunk.encoding == "base64", chunk.offset == offset, chunk.size >= 0,
                  total == nil || total == chunk.size,
                  let bytes = Data(base64Encoded: chunk.data), bytes.count <= Self.blobChunkBytes,
                  offset + bytes.count <= chunk.size
            else { throw V2BusinessError.blobMalformed }
            if total == nil {
                guard chunk.size <= maxBytes else { throw V2BusinessError.blobTooLarge(size: chunk.size, limit: maxBytes) }
                total = chunk.size
                name = chunk.name
                mediaType = chunk.mediaType
                data.reserveCapacity(chunk.size)
            }
            data.append(bytes)
            offset += bytes.count
            if chunk.eof {
                guard offset == chunk.size else { throw V2BusinessError.blobIncomplete }
                return V2SessionBlob(blobRef: blobRef, name: name, mediaType: mediaType, data: data)
            }
            // An empty chunk before the end would never advance the offset.
            guard !bytes.isEmpty else { throw V2BusinessError.blobIncomplete }
        }
    }
}
