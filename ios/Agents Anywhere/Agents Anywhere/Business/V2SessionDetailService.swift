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

    func latestItems(sessionId: V2SessionID, limit: Int = 100) async throws -> V2SessionTimelinePage {
        try validatePageSize(limit)
        return try await sessionAPI.latestTimeline(sessionId: sessionId, limit: limit)
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
        if attachmentIds.count > 10 { throw V2BusinessError.tooManyAttachments(maximum: 10) }
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
        ).requireSuccess()
    }

    func steer(
        sessionId: V2SessionID,
        content: String,
        attachmentIds: [V2AttachmentID],
        clientMessageId: String
    ) async throws -> V2RuntimeActionResponse {
        let normalizedContent = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if attachmentIds.count > 10 { throw V2BusinessError.tooManyAttachments(maximum: 10) }
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
        ).requireSuccess()
    }

    func interrupt(sessionId: V2SessionID) async throws -> V2RuntimeActionResponse {
        try await runtimeAPI.interrupt(sessionId: sessionId).requireSuccess()
    }

    func updateSelection(
        sessionId: V2SessionID,
        scope: V2RuntimeSelectionScope,
        selectionId: V2SelectionID?
    ) async throws -> V2RuntimeState? {
        let response = try await runtimeAPI.updateSelections(
            sessionId: sessionId,
            request: V2RuntimeSelectionUpdateRequest(selections: [scope: selectionId])
        )
        guard response.ok else {
            throw V2RuntimeError(code: response.connectorResult?["error"]?["code"]?.stringValue,
                message: response.connectorResult?["error"]?["message"]?.stringValue ?? "The runtime did not accept this selection.")
        }
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

    func setTakeover(sessionId: V2SessionID, enabled: Bool) async throws -> V2SessionMeta {
        try await sessionAPI.setTakeover(sessionId: sessionId, enabled: enabled).session
    }

    func sync(sessionId: V2SessionID) async throws -> V2RuntimeActionResponse {
        try await sessionAPI.sync(sessionId: sessionId).requireSuccess()
    }

    /// Recovery replays durable data only. Refresh ephemeral runtime facts separately.
    func liveState(sessionId: V2SessionID) async throws -> V2SessionLiveState {
        async let state = runtimeAPI.state(sessionId: sessionId)
        async let capabilities = runtimeAPI.capabilities(sessionId: sessionId)
        async let notices = runtimeAPI.notices(sessionId: sessionId)
        return try await V2SessionLiveState(
            state: state.state, capabilities: capabilities.capabilitySet, notices: notices.notices
        )
    }

    func catalogs(sessionId: V2SessionID, scopes: Set<String>? = nil) async throws -> V2SessionCatalogs {
        async let model = scopes?.contains("model") != false
            ? runtimeAPI.modelCatalog(sessionId: sessionId).catalog
            : V2ModelCatalog(runtime: "", revision: 0, models: [])
        async let permission = scopes?.contains("permission") != false
            ? runtimeAPI.permissionCatalog(sessionId: sessionId).catalog
            : V2PermissionCatalog(runtime: "", revision: 0, permissions: [])
        return try await V2SessionCatalogs(model: model, permission: permission)
    }

    private func validatePageSize(_ limit: Int) throws {
        if !(1...500).contains(limit) {
            throw V2BusinessError.invalidPageSize
        }
    }
}
