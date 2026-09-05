import Foundation

struct V2SessionCatalogs: Hashable {
    let model: V2ModelCatalog
    let permission: V2PermissionCatalog
}

struct V2SessionLiveState: Hashable {
    let state: V2RuntimeState
    let capabilities: V2RuntimeCapabilitySnapshot
    let notices: [V2RuntimeNotice]
}

/// Cached content is readable while disconnected; live controls require fresh runtime facts.
enum V2SessionConnectionState: Hashable {
    case inactive
    case connecting
    case connected
    case reconnecting
    case failed(String)
}

struct V2SessionData: Hashable {
    var session: V2SessionMeta
    var items: [V2TimelineItem]
    var hasOlderItems: Bool
    var state: V2RuntimeState?
    var capabilities: V2RuntimeCapabilitySnapshot
    var notices: [V2RuntimeNotice]
    var cursor: String
    var connection: V2SessionConnectionState = .inactive
    var liveStateIsFresh = false
    var error: String?

    init(snapshot: V2SessionSnapshot) {
        session = snapshot.session
        items = snapshot.timeline.items.sorted { $0.orderSeq < $1.orderSeq }
        hasOlderItems = snapshot.timeline.hasMore
        state = snapshot.state
        capabilities = snapshot.effectiveCapabilities
        notices = snapshot.notices
        cursor = snapshot.eventCursor
    }
}
