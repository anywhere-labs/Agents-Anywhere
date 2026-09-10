import Foundation

/// A local session is a navigation destination immediately, before creation has
/// completed. Its clientMessageId remains unchanged when bound to the server ID.
struct NewSessionSubmission {
    let session: V2SessionMeta
    let pending: V2PendingMessage
    init(project: V2Project, runtime: V2DeviceRuntime, text: String, attachments: [ChatAttachment]) {
        let id = "local:" + UUID().uuidString
        let now = Date().ISO8601Format()
        session = V2SessionMeta(id: id, connectorId: project.connectorId, projectId: project.id,
            runtime: runtime.runtimeType, runtimeId: runtime.id, runtimeType: runtime.runtimeType,
            runtimeName: runtime.name, runtimeTypeDisplayName: runtime.typeDisplayName,
            externalSessionId: nil, title: String(text.prefix(80)), cwd: project.workspacePath, status: .waiting,
            takeover: true, connectorStatus: .online, pinned: false, pinnedAt: nil, archived: false,
            archivedAt: nil, userArchived: false, sourceAvailability: "available", sourceAvailabilityReason: nil,
            sourceAvailabilityUpdatedAt: nil, sourceObservationOrigin: nil, archiveSource: nil, unread: false,
            lastReadSeq: 0, latestTurnEndSeq: 0, lastSyncedAt: nil, sourceObservedAt: nil, lastActivityAt: now,
            lastItemAt: now, lastItemOrderSeq: 1, sortAt: now, updatedSeq: 0)
        pending = V2PendingMessage(id: UUID().uuidString, content: text, attachmentIDs: [],
            localAttachmentIDs: attachments.map(\.id), attachments: attachments)
    }
}
