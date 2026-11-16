import Foundation

nonisolated struct V2SessionCatalogs: Hashable {
    let model: V2ModelCatalog
    let permission: V2PermissionCatalog
}

nonisolated struct V2SessionLiveState: Hashable {
    let state: V2RuntimeState
    let capabilities: V2RuntimeCapabilitySnapshot
    let notices: [V2RuntimeNotice]
}

/// Cached content is readable while disconnected; live controls require fresh runtime facts.
nonisolated enum V2SessionConnectionState: Hashable {
    case inactive
    case connecting
    case connected
    case reconnecting
    case offline
    case failed(String)
}

nonisolated struct V2SessionData: Hashable {
    var session: V2SessionMeta
    var items: [V2TimelineItem]
    var hasOlderItems: Bool
    var hasNewerItems = false
    var state: V2RuntimeState?
    var capabilities: V2RuntimeCapabilitySnapshot
    var notices: [V2RuntimeNotice]
    var cursor: String
    var liveStateIsFresh = false
    var lastExtensionEvent: V2SessionEvent?
    var queue: V2SessionQueueState?
    /// The Server could not read history because the device is offline (protocol 1.2).
    /// Live status only: never archived.
    var historyUnavailable = false
    /// False for a projection built from an offline snapshot without any retained
    /// content. It is not an authoritative base: its cursor is `seq:0`, its timeline
    /// is not archived and the next online read replaces it with a snapshot.
    var hasBaseline = true

    init(snapshot: V2SessionSnapshot) {
        session = snapshot.session
        items = snapshot.timeline.items.sorted { $0.orderSeq < $1.orderSeq }
        hasOlderItems = snapshot.timeline.hasMore
        state = snapshot.state
        capabilities = snapshot.effectiveCapabilities
        notices = snapshot.notices
        cursor = snapshot.eventCursor
        queue = snapshot.queue
        historyUnavailable = snapshot.historyUnavailable
    }
}

nonisolated struct V2SessionObservation: Hashable {
    let sessionId: V2SessionID
    let data: V2SessionData?
    let connection: V2SessionConnectionState
    let error: V2ClientFailure?
}
