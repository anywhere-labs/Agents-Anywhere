import Foundation

nonisolated struct V2PairingClaimRequest: Encodable, Hashable {
    let code: String
    let name: String
    let serverUrl: String
    let connectorId: V2ConnectorID
    let connectorToken: String
}

nonisolated struct V2PairingClaimResponse: Decodable, Hashable {
    let status: String
    let connector: V2Connector?
}

nonisolated enum V2DeviceRuntimeStatus: String, Decodable, Hashable {
    init(from decoder: Decoder) throws {
        // A status a newer Server adds must not hide the runtime list.
        self = Self(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }

    case stopped
    case discovering
    case available
    case unavailable
    case validating
    case starting
    case running
    case stopping
    case error
    case unknown
}

nonisolated struct V2DeviceRuntime: Decodable, Identifiable, Hashable {
    let connectorId: V2ConnectorID
    let runtimeId: V2RuntimeID
    let runtimeType: String
    let name: String
    let displayName: String
    let typeDisplayName: String
    let present: Bool
    let available: Bool
    let reason: String?
    let configured: Bool
    let active: Bool
    let status: V2DeviceRuntimeStatus
    let discovery: JSONValue
    let metadata: JSONValue
    let schema: JSONValue?
    let uiSchema: JSONValue
    let defaults: [String: JSONValue]
    let capabilities: [String: Bool]
    let config: JSONValue?
    let error: JSONValue?
    /// Step inside a non-error status (e.g. syncing while starting). Informational only.
    let phase: JSONValue?
    /// Declared by the runtime adapter; shown beside the status, never instead of it.
    let maturity: String?
    /// How the runtime takes a model connection; absent when it takes none.
    let modelConnection: V2ModelConnectionCapability?
    let modelConnectionStatus: V2ModelConnectionStatus?
    /// Saved write-only values by config path, e.g. `modelGateway.apiKey`. Values never arrive.
    let secretFields: [String: V2RuntimeSecretField]?
    /// Set on instances another feature created, such as `model-config`.
    let managedBy: String?
    let lastDiscoveredAt: String
    let createdAt: String
    let updatedAt: String

    var id: V2RuntimeID { runtimeId }
    var target: V2ModelTarget { .init(connectorId: connectorId, runtimeId: runtimeId) }
    /// The maturity a badge shows: the model connection's when it has one.
    var badgeMaturity: String? { modelConnection?.maturity ?? maturity }
}

nonisolated struct V2DeviceRuntimeListResponse: Decodable, Hashable {
    let connectorId: V2ConnectorID
    let runtimes: [V2DeviceRuntime]
    let serverTime: String
}

nonisolated struct V2RuntimeConfigUpdateRequest: Encodable, Hashable {
    let config: [String: JSONValue]
}

nonisolated struct V2RuntimeActiveUpdateRequest: Encodable, Hashable {
    let active: Bool
}
