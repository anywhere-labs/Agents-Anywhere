import Foundation

nonisolated enum V2TimelineMode: String {
    case latest
    case changes
    case history
}

nonisolated struct V2SessionTimelinePage: Decodable, Hashable {
    let sessionId: V2SessionID
    let items: [V2TimelineItem]
    let nextSeq: Int
    let hasMore: Bool
    let serverTime: String?
}

nonisolated struct V2SessionSnapshot: Decodable, Hashable {
    let session: V2SessionMeta
    let state: V2RuntimeState?
    let timeline: V2TimelineSnapshot
    let approvals: [V2Approval]
    let notices: [V2RuntimeNotice]
    let effectiveCapabilities: V2RuntimeCapabilitySnapshot
    let runtimeCapabilities: V2RuntimeCapabilitySnapshot
    let catalogs: [String: JSONValue]
    let eventCursor: String
    let serverTime: String
}

nonisolated struct V2TimelineSnapshot: Decodable, Hashable {
    let items: [V2TimelineItem]
    let nextSeq: Int
    let hasMore: Bool
}

nonisolated struct V2Approval: Decodable, Identifiable, Hashable {
    let id: String
    let sessionId: V2SessionID
    let turnId: V2TurnID?
    let status: String
    let kind: String
    let targetItemId: V2TimelineItemID?
    let title: String
    let description: String?
    let payload: JSONValue
    let choices: [String]
    let source: JSONValue
    let createdAt: String
    let resolvedAt: String?
    let updatedSeq: Int
}
