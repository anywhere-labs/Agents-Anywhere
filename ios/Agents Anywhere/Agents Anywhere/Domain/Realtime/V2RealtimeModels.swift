import Foundation

enum V2RealtimeScope: Hashable {
    case dashboard
    case session(V2SessionID)
}

struct V2WebSocketTicketRequest: Encodable, Hashable {
    let clientId: String
    let scope: V2WebSocketTicketScope
}

struct V2WebSocketTicketScope: Encodable, Hashable {
    let sessionId: V2SessionID?
    let dashboard: Bool

    init(scope: V2RealtimeScope) {
        switch scope {
        case .dashboard:
            sessionId = nil
            dashboard = true
        case let .session(sessionId):
            self.sessionId = sessionId
            dashboard = false
        }
    }
}

struct V2WebSocketTicket: Decodable, Hashable {
    let ticket: String
    let expiresAt: String
    let serverTime: String
}

struct V2SessionEvent: Decodable, Identifiable, Hashable {
    let protocolVersion: String
    let eventId: String
    let sequence: Int
    let cursor: String
    let type: String
    let sessionId: V2SessionID
    let emittedAt: String
    let payload: JSONValue

    var id: String { eventId }
}

struct V2EventRecoveryResponse: Decodable, Hashable {
    let events: [V2SessionEvent]
    let nextCursor: String
    let snapshotRequired: Bool
    let serverTime: String
}

struct V2DashboardSnapshot: Decodable, Hashable {
    let type: String
    let connectors: [V2Connector]
    let sessions: [V2SessionMeta]
    let serverTime: String
}
