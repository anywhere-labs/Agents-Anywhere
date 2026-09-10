import Foundation

enum V2CapabilityScope: String, Codable, Hashable {
    case runtime
    case session
}

struct V2RuntimeCapability: Decodable, Identifiable, Hashable {
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

    var id: V2CapabilityID { capabilityId }
}

struct V2RuntimeCapabilityResponse: Decodable, Hashable {
    let connectorId: V2ConnectorID
    let capabilitySet: V2RuntimeCapabilitySnapshot
    let serverTime: String
}

struct V2RuntimeCapabilitySnapshot: Decodable, Hashable {
    let revision: Int
    let capabilities: [V2RuntimeCapability]

    func capability(id: V2CapabilityID) -> V2RuntimeCapability? {
        capabilities.first { capability in capability.capabilityId == id }
    }
}
