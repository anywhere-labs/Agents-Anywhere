import Foundation

struct V2SessionCreationService {
    let sessionAPI: any V2SessionAPIProtocol

    /// Encodes initial attachments inline because no session-scoped upload resource exists before creation.
    func createAndStart(
        connectorId: V2ConnectorID,
        runtime: V2RuntimeID,
        title: String?,
        cwd: String?,
        content: String,
        selections: [V2RuntimeSelectionScope: V2SelectionID],
        attachments: [V2LocalAttachment],
        clientMessageId: String
    ) async throws -> V2SessionCreateResponse {
        let normalizedContent = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalizedContent.isEmpty, attachments.isEmpty {
            throw V2BusinessError.emptyMessage
        }
        if attachments.count > 10 {
            throw V2BusinessError.tooManyAttachments(maximum: 10)
        }
        let inlineAttachments = try attachments.map { attachment in
            if attachment.data.isEmpty {
                throw V2BusinessError.emptyAttachment(name: attachment.name)
            }
            return V2InlineAttachment(
                fileId: attachment.fileId,
                name: attachment.name,
                mediaType: attachment.mediaType,
                size: attachment.data.count,
                sha256: attachment.sha256,
                contentBase64: attachment.data.base64EncodedString()
            )
        }
        return try await sessionAPI.createAndStartSession(
            request: V2SessionCreateAndStartRequest(
                connectorId: connectorId,
                runtime: runtime,
                title: title,
                cwd: cwd,
                content: normalizedContent,
                selections: selections,
                attachments: inlineAttachments,
                clientMessageId: clientMessageId
            )
        )
    }

    func bindExisting(
        connectorId: V2ConnectorID,
        runtime: V2RuntimeID,
        externalSessionId: String,
        title: String?,
        cwd: String?,
        selections: [V2RuntimeSelectionScope: V2SelectionID]
    ) async throws -> V2SessionCreateResponse {
        try await sessionAPI.createSession(
            request: V2SessionCreateRequest(
                connectorId: connectorId,
                runtime: runtime,
                externalSessionId: externalSessionId,
                title: title,
                cwd: cwd,
                selections: selections
            )
        )
    }
}
