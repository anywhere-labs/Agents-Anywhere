import Foundation

struct V2RuntimeConfigDescriptor: Decodable, Hashable {
    let revision: Int
    let schema: JSONValue
    let uiSchema: JSONValue?
    let defaults: [String: JSONValue]
    let metadata: [String: JSONValue]
}

struct V2RuntimeType: Decodable, Identifiable, Hashable {
    let connectorId: V2ConnectorID
    let runtimeType: String
    let implementationType: String?
    let displayName: String
    let description: String?
    let present: Bool
    let available: Bool
    let reason: String?
    let recommended: Bool
    let recommendationRank: Int?
    let discovery: JSONValue
    let configSchema: V2RuntimeConfigDescriptor?
    let schema: JSONValue?
    let uiSchema: JSONValue
    let defaults: [String: JSONValue]
    let capabilities: [String: Bool]
    let metadata: JSONValue
    let instancePolicy: String
    let maxInstances: Int?
    let lastDiscoveredAt: String
    let createdAt: String
    let updatedAt: String

    var id: String { runtimeType }
}

struct V2RuntimeTypeListResponse: Decodable, Hashable {
    let connectorId: V2ConnectorID
    let runtimeTypes: [V2RuntimeType]
    let serverTime: String
}

struct V2RuntimeInstanceCreateRequest: Encodable, Hashable {
    let runtimeType: String
    let name: String
    let config: [String: JSONValue]
    let active: Bool
}

struct V2RuntimeInstanceRenameRequest: Encodable, Hashable {
    let name: String
}

struct V2RuntimeInventory: Hashable {
    let types: [V2RuntimeType]
    let instances: [V2DeviceRuntime]

    var configuredInstances: [V2DeviceRuntime] { instances.filter(\.configured) }

    /// A cleared instance keeps its identity/history and can be configured again.
    func reconfigurableInstance(for type: V2RuntimeType) -> V2DeviceRuntime? {
        instances.first { $0.runtimeType == type.runtimeType && !$0.configured }
    }

    func canAdd(_ type: V2RuntimeType) -> Bool {
        guard type.present, type.schema != nil || type.configSchema != nil else { return false }
        if reconfigurableInstance(for: type) != nil { return true }
        let count = instances.filter { $0.runtimeType == type.runtimeType }.count
        if type.instancePolicy == "single", count >= 1 { return false }
        guard ["single", "multiple"].contains(type.instancePolicy) else { return false }
        return type.maxInstances.map { count < $0 } ?? true
    }
}

struct V2ConnectorPreferencesResponse: Decodable, Hashable {
    let connectorId: V2ConnectorID
    let preferences: [String: JSONValue]
    let serverTime: String
}
