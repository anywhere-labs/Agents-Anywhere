import Foundation

nonisolated struct V2DashboardArchive: Codable {
    struct Page: Codable { let scope: V2SessionListScope; let info: V2SessionPageInfo }
    let connectors: [V2Connector]
    let projects: [V2Project]
    let sessions: [V2SessionMeta]
    let pages: [Page]
    var firstPageIDs: Set<String>? = nil
    var extendedScopes: Set<V2SessionListScope>? = nil
    struct Membership: Codable { let scope: V2SessionListScope; let ids: Set<String> }
    var projectMemberships: [Membership]? = nil
}

nonisolated struct V2SessionArchive: Codable {
    struct Pending: Codable {
        let id: String
        let content: String
        let attachmentIDs: [String]
        let attachments: [ChatAttachment]
        let error: String?
        let rejected: Bool
    }
    let session: V2SessionMeta
    let items: [JSONValue]
    let cursor: String
    let hasOlderItems: Bool
    let hasNewerItems: Bool
    let draft: String
    let draftAttachments: [ChatAttachment]
    let pending: [Pending]
    var previews: ChatAttachmentStore.Archive? = nil
    /// False when only local work (draft, unconfirmed sends) is kept for a session
    /// without an authoritative snapshot; nil in archives that predate it.
    var baseline: Bool? = nil

    @MainActor init(data: V2SessionData, model: V2SessionModel) {
        session = data.session; cursor = data.hasBaseline ? data.cursor : "seq:0"
        items = data.hasBaseline ? data.items.map(\.raw) : []
        hasOlderItems = data.hasBaseline && data.hasOlderItems; hasNewerItems = data.hasBaseline && data.hasNewerItems
        baseline = data.hasBaseline ? nil : false
        previews = model.attachmentPreviews.archived()
        draft = model.draft; draftAttachments = model.composer.attachments.map { $0.archived() }
        pending = model.pendingMessages.filter { $0.delivery != .confirmed }.map { value in
            let error: String?; let rejected: Bool
            switch value.delivery {
            case .rejected(let failure): error = failure.message; rejected = true
            case .uncertain(let failure): error = failure.message; rejected = false
            default: error = nil; rejected = false
            }
            return Pending(id: value.id, content: value.content, attachmentIDs: value.attachmentIDs,
                attachments: value.attachments.map { $0.archived() }, error: error, rejected: rejected)
        }
    }

    @MainActor func projection(maximumItems: Int) throws -> V2SessionProjection {
        projection(items: try items.map { try V2TimelineItem(json: $0) }, maximumItems: maximumItems)
    }

    @MainActor func projection(items decoded: [V2TimelineItem], maximumItems: Int) -> V2SessionProjection {
        let empty = V2RuntimeCapabilitySnapshot(revision: 0, capabilities: [])
        let snapshot = V2SessionSnapshot(session: session, state: nil,
            timeline: .init(items: decoded, nextSeq: V2SessionProjection.sequence(cursor), hasMore: hasOlderItems),
            approvals: [], notices: [], effectiveCapabilities: empty, runtimeCapabilities: empty,
            catalogs: [:], eventCursor: cursor, serverTime: "")
        var projection = V2SessionProjection(archive: snapshot, hasNewerItems: hasNewerItems, maximumItems: maximumItems)
        if baseline == false { projection.markWithoutBaseline() }
        return projection
    }
}

/// An archive plus its timeline already decoded by the store actor.
nonisolated struct V2SessionRestore {
    let archive: V2SessionArchive
    let items: [V2TimelineItem]
}

extension ChatAttachment {
    func archived() -> Self {
        // Uploaded bytes are retrievable by fileId. Keep the small thumbnail and
        // original local bytes only while an upload has not completed.
        var copy = Self(id: id, name: name, data: uploaded == nil ? data : Data(), mediaType: mediaType, previewData: previewData)
        copy.uploaded = uploaded
        return copy
    }
}
