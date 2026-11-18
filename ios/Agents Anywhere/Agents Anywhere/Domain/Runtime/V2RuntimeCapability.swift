import Foundation

nonisolated enum V2CapabilityScope: String, Codable, Hashable {
    case runtime
    case session
}

nonisolated struct V2RuntimeCapability: Decodable, Identifiable, Hashable {
    let capabilityId: V2CapabilityID
    let version: String
    let scope: V2CapabilityScope
    let runtime: V2RuntimeID?
    let sessionId: V2SessionID?
    let supported: Bool
    let available: Bool
    let allowed: Bool
    let unavailableReason: String?
    let parameters: JSONValue
    var metadata: JSONValue? = nil

    var id: V2CapabilityID { capabilityId }
}

nonisolated struct V2RuntimeCapabilityResponse: Decodable, Hashable {
    let connectorId: V2ConnectorID
    let capabilitySet: V2RuntimeCapabilitySnapshot
    let serverTime: String
}

nonisolated struct V2RuntimeCapabilitySnapshot: Decodable, Hashable {
    let revision: Int
    let capabilities: [V2RuntimeCapability]

    func capability(id: V2CapabilityID) -> V2RuntimeCapability? {
        capabilities.first { capability in capability.capabilityId == id }
    }

    /// `session.port_preview` is declared and usable (the device has its frp client); takeover is not needed.
    var portPreviewAvailable: Bool {
        guard let capability = capability(id: "session.port_preview") else { return false }
        return capability.supported && capability.available
    }
}
