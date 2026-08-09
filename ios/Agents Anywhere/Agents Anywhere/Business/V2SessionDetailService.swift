import Foundation

struct V2SessionDetailService {
    let sessionAPI: any V2SessionAPIProtocol
    let runtimeAPI: any V2RuntimeAPIProtocol
    let realtimeAPI: any V2RealtimeAPIProtocol

    func load(sessionId: V2SessionID, itemLimit: Int = 100) async throws -> V2SessionSnapshot {
        try validatePageSize(itemLimit)
        return try await sessionAPI.snapshot(sessionId: sessionId, limit: itemLimit)
    }

    func loadOlderItems(
        sessionId: V2SessionID,
        beforeOrderSeq: Int,
        limit: Int = 100
    ) async throws -> V2SessionTimelinePage {
        try validatePageSize(limit)
        return try await sessionAPI.timelineHistory(
            sessionId: sessionId,
            beforeOrderSeq: beforeOrderSeq,
            limit: limit
        )
    }

    func refreshRuntimeState(sessionId: V2SessionID) async throws -> V2RuntimeState {
        try await runtimeAPI.state(sessionId: sessionId).state
    }

    func sendMessage(
        sessionId: V2SessionID,
        content: String,
        attachmentIds: [V2AttachmentID],
        clientMessageId: String
    ) async throws -> V2RuntimeActionResponse {
        let normalizedContent = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalizedContent.isEmpty, attachmentIds.isEmpty {
            throw V2BusinessError.emptyMessage
        }
        return try await runtimeAPI.sendMessage(
            sessionId: sessionId,
            request: V2RuntimeMessageSendRequest(
                content: normalizedContent,
                attachments: attachmentIds.map { V2AttachmentSendReference(fileId: $0) },
                clientMessageId: clientMessageId
            )
        )
    }

    func steer(
        sessionId: V2SessionID,
        content: String,
        attachmentIds: [V2AttachmentID],
        clientMessageId: String
    ) async throws -> V2RuntimeActionResponse {
        let normalizedContent = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalizedContent.isEmpty, attachmentIds.isEmpty {
            throw V2BusinessError.emptyMessage
        }
        return try await runtimeAPI.steer(
            sessionId: sessionId,
            request: V2RuntimeSteerRequest(
                content: normalizedContent,
                attachments: attachmentIds.map { V2AttachmentSendReference(fileId: $0) },
                clientMessageId: clientMessageId
            )
        )
    }

    func interrupt(sessionId: V2SessionID) async throws -> V2RuntimeActionResponse {
        try await runtimeAPI.interrupt(sessionId: sessionId)
    }

    func updateSelection(
        sessionId: V2SessionID,
        scope: V2RuntimeSelectionScope,
        selectionId: V2SelectionID
    ) async throws -> V2RuntimeState? {
        let response = try await runtimeAPI.updateSelections(
            sessionId: sessionId,
            request: V2RuntimeSelectionUpdateRequest(selections: [scope: selectionId])
        )
        return response.state
    }

    /// Opens the session push channel after obtaining a single-use ticket.
    func updates(
        sessionId: V2SessionID,
        clientId: String
    ) async throws -> AsyncThrowingStream<V2SessionEvent, Error> {
        let ticket = try await realtimeAPI.ticket(clientId: clientId, scope: .session(sessionId))
        return try realtimeAPI.sessionEvents(sessionId: sessionId, ticket: ticket.ticket)
    }

    func recover(
        sessionId: V2SessionID,
        after cursor: String
    ) async throws -> V2EventRecoveryResponse {
        try await realtimeAPI.recover(sessionId: sessionId, after: cursor)
    }

    private func validatePageSize(_ limit: Int) throws {
        if !(1...500).contains(limit) {
            throw V2BusinessError.invalidPageSize
        }
    }
}
