import Foundation

struct V2AttachmentService {
    let attachmentAPI: any V2AttachmentAPIProtocol

    /// Uploads user-selected bytes to the server's session-scoped attachment store.
    func upload(
        sessionId: V2SessionID,
        attachments: [V2LocalAttachment]
    ) async throws -> [V2AttachmentReference] {
        if attachments.count > 5 {
            throw V2BusinessError.tooManyAttachments(maximum: 5)
        }
        let files = try attachments.map { attachment in
            if attachment.data.isEmpty {
                throw V2BusinessError.emptyAttachment(name: attachment.name)
            }
            return HTTPUploadFile(
                fieldName: "files",
                fileName: attachment.name,
                mediaType: attachment.mediaType,
                data: attachment.data
            )
        }
        return try await attachmentAPI.upload(sessionId: sessionId, files: files).attachments
    }

    func download(sessionId: V2SessionID, fileId: V2AttachmentID) async throws -> Data {
        let response = try await attachmentAPI.download(sessionId: sessionId, fileId: fileId)
        guard let data = Data(base64Encoded: response.contentBase64) else {
            throw HTTPError.decoding(message: "The attachment content is not valid Base64 data.")
        }
        return data
    }
}
