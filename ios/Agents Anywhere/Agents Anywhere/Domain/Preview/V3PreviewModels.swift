import Foundation

// Port preview 1.0 (contracts/preview/1.0). The client API lives under
// `/api/v3/previews`; port facts arrive as `port.listening` / `port.closed`
// envelopes on the session socket.

/// A port a device process listens on (`ListeningPort`).
nonisolated struct V3ListeningPort: Codable, Hashable, Identifiable {
    let port: Int
    var pid: Int? = nil
    var processName: String? = nil
    var sessionId: V2SessionID? = nil
    /// The address the Agent printed, when it printed one.
    var url: String? = nil

    var id: Int { port }
    /// What the card shows: the printed address, or localhost.
    var localURL: String {
        if let url, !url.isEmpty { return url }
        return "http://localhost:\(port)"
    }
}

/// Device event `port.listening`: the device's whole current list, not a delta.
nonisolated struct V3PortListeningEvent: Codable, Hashable {
    let deviceId: String
    var ports: [V3ListeningPort]? = nil
}

/// Device event `port.closed`.
nonisolated struct V3PortClosedEvent: Codable, Hashable {
    let deviceId: String
    let port: Int
}

nonisolated enum V3PreviewVisibility: String, Codable, Hashable {
    case `private`
    case link
}

/// `CreatePreviewRequest`. Optional fields are omitted when nil.
nonisolated struct V3CreatePreviewRequest: Encodable, Hashable {
    let deviceId: String
    let port: Int
    var sessionId: V2SessionID? = nil
    var visibility: V3PreviewVisibility = .private
    var ttlHours: Int? = nil
}

/// `PreviewView`. `state` and `closeReason` stay strings so a newer Server's
/// values never fail the decode.
nonisolated struct V3PreviewView: Decodable, Hashable, Identifiable {
    let previewId: String
    let slug: String
    let deviceId: String
    var sessionId: V2SessionID? = nil
    let port: Int
    let visibility: String
    /// `opening`, `open` or `closed`.
    let state: String
    var closeReason: String? = nil
    /// The preview domain address (`https://<slug>.<preview domain>`); copyable, needs sign-in.
    var url: String? = nil
    let expiresAt: String
    /// E2EE mode: preview traffic is relayed in plaintext by the Server.
    var plaintextNotice: Bool = false

    var id: String { previewId }
    var isClosed: Bool { state == "closed" }

    enum CodingKeys: String, CodingKey {
        case previewId, slug, deviceId, sessionId, port, visibility, state, closeReason, url, expiresAt, plaintextNotice
    }

    init(previewId: String, slug: String, deviceId: String, sessionId: V2SessionID? = nil, port: Int,
         visibility: String = "private", state: String, closeReason: String? = nil, url: String? = nil,
         expiresAt: String, plaintextNotice: Bool = false) {
        self.previewId = previewId; self.slug = slug; self.deviceId = deviceId; self.sessionId = sessionId
        self.port = port; self.visibility = visibility; self.state = state; self.closeReason = closeReason
        self.url = url; self.expiresAt = expiresAt; self.plaintextNotice = plaintextNotice
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        previewId = try container.decode(String.self, forKey: .previewId)
        slug = try container.decode(String.self, forKey: .slug)
        deviceId = try container.decode(String.self, forKey: .deviceId)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
        port = try container.decode(Int.self, forKey: .port)
        visibility = try container.decodeIfPresent(String.self, forKey: .visibility) ?? "private"
        state = try container.decode(String.self, forKey: .state)
        closeReason = try container.decodeIfPresent(String.self, forKey: .closeReason)
        url = try container.decodeIfPresent(String.self, forKey: .url)
        expiresAt = try container.decode(String.self, forKey: .expiresAt)
        plaintextNotice = try container.decodeIfPresent(Bool.self, forKey: .plaintextNotice) ?? false
    }
}

/// `PreviewListResponse`.
nonisolated struct V3PreviewListResponse: Decodable, Hashable {
    let previews: [V3PreviewView]
}

/// `PreviewTicketResponse`: a one-time, short-lived URL that the preview domain
/// exchanges for its own cookie. Request a new one for every open.
nonisolated struct V3PreviewTicket: Decodable, Hashable {
    let ticketUrl: String
    let expiresAt: String
}
