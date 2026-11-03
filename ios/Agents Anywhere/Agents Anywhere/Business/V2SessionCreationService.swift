import Foundation

struct V2SessionCreationService {
    let sessionAPI: any V2SessionAPIProtocol

    /// Encodes initial attachments inline because no session-scoped upload resource exists before creation.
    func createAndStart(
        connectorId: V2ConnectorID,
        projectId: String,
        runtime: V2RuntimeID,
        runtimeId: V2RuntimeID? = nil,
        title: String?,
        cwd: String?,
        content: String,
        selections: [V2RuntimeSelectionScope: V2SelectionID],
        attachments: [V2LocalAttachment],
        clientMessageId: String
    ) async throws -> V2SessionCreateResponse {
        let intent = V2PlanningCommand.parse(content)
        if intent?.command == "exit_plan" || intent?.command == "enter_plan" { throw V2BusinessError.emptyMessage }
        let normalizedContent = intent == nil ? content.trimmingCharacters(in: .whitespacesAndNewlines) : intent?.content ?? ""
        if normalizedContent.isEmpty, attachments.isEmpty, intent == nil {
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
                projectId: projectId,
                runtime: runtime,
                runtimeId: runtimeId,
                title: title,
                cwd: cwd,
                planningIntent: intent == nil ? nil : V2PlanningIntent(operationId: clientMessageId),
                content: normalizedContent,
                selections: selections,
                attachments: inlineAttachments,
                clientMessageId: clientMessageId
            )
        )
    }

    func bindExisting(
        connectorId: V2ConnectorID,
        projectId: String,
        runtime: V2RuntimeID,
        runtimeId: V2RuntimeID? = nil,
        externalSessionId: String,
        title: String?,
        cwd: String?,
        selections: [V2RuntimeSelectionScope: V2SelectionID]
    ) async throws -> V2SessionCreateResponse {
        try await sessionAPI.createSession(
            request: V2SessionCreateRequest(
                connectorId: connectorId,
                projectId: projectId,
                runtime: runtime,
                runtimeId: runtimeId,
                externalSessionId: externalSessionId,
                title: title,
                cwd: cwd,
                selections: selections
            )
        )
    }
}
