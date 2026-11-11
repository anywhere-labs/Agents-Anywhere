import Foundation

nonisolated enum V2RealtimeScope: Hashable {
    case dashboard
    case session(V2SessionID)
}

nonisolated struct V2WebSocketTicketRequest: Encodable, Hashable {
    let clientId: String
    let scope: V2WebSocketTicketScope
}

nonisolated struct V2WebSocketTicketScope: Encodable, Hashable {
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

nonisolated struct V2WebSocketTicket: Decodable, Hashable {
    let ticket: String
    let expiresAt: String
    let serverTime: String
}

nonisolated struct V2SessionEvent: Decodable, Identifiable, Hashable {
    let protocolVersion: String
    let eventId: String
    let sequence: Int
    let cursor: String
    let type: String
    let sessionId: V2SessionID
    let emittedAt: String
    let payload: JSONValue
    /// Client receipt time, excluded from the wire contract. Used to order refresh barriers.
    var receivedAt: Date = Date()

    enum CodingKeys: String, CodingKey {
        case protocolVersion, eventId, sequence, cursor, type, sessionId, emittedAt, payload
    }

    var id: String { eventId }

    var isLiveProjection: Bool {
        ["session.meta.updated", "runtime.state.updated", "runtime.capability.updated", "runtime.catalog.updated"].contains(type)
    }
}

nonisolated struct V2EventRecoveryResponse: Decodable, Hashable {
    let events: [V2SessionEvent]
    let nextCursor: String
    let snapshotRequired: Bool
    let serverTime: String
}

nonisolated struct V2DashboardSnapshot: Decodable, Hashable {
    let type: String
    let connectors: [V2Connector]
    let projects: [V2Project]
    let sessionPages: V2DashboardSessionPages
    let sessions: [V2SessionMeta]
    /// Every runtime instance; nil when the Server does not send the list.
    let runtimes: [V2DeviceRuntime]?
    /// Model profiles, assignments and the Tokens Anywhere link; nil when absent.
    let modelConfig: V2ModelConfigOverview?
    let serverTime: String

    private enum CodingKeys: String, CodingKey {
        case type, connectors, projects, sessionPages, sessions, runtimes, modelConfig, serverTime
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        connectors = try container.decode([V2Connector].self, forKey: .connectors)
        projects = try container.decode([V2Project].self, forKey: .projects)
        sessionPages = try container.decode(V2DashboardSessionPages.self, forKey: .sessionPages)
        sessions = try container.decode([V2SessionMeta].self, forKey: .sessions)
        // Model configuration is additive: a shape this client does not know
        // must never stop the device and session lists from updating.
        runtimes = (try? container.decodeIfPresent(V2LossyArray<V2DeviceRuntime>.self, forKey: .runtimes))?.values
        modelConfig = try? container.decodeIfPresent(V2ModelConfigOverview.self, forKey: .modelConfig)
        serverTime = try container.decode(String.self, forKey: .serverTime)
    }
}
