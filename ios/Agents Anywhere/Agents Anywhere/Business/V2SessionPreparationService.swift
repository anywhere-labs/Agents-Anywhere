import Foundation

struct V2PreparedSession: Hashable {
    let runtime: V2DeviceRuntime
    let capabilities: V2RuntimeCapabilitySnapshot
    let catalogs: V2SessionCatalogs
}

struct V2SessionPreparationService {
    let connectorAPI: any V2ConnectorAPIProtocol

    /// New-session catalogs are Connector/instance resources; no session is created here.
    func prepare(connectorId: V2ConnectorID, runtimeId: V2RuntimeID) async throws -> V2PreparedSession {
        async let runtime = connectorAPI.runtime(connectorId: connectorId, runtimeId: runtimeId)
        let capabilities = try await connectorAPI.runtimeCapabilities(connectorId: connectorId, runtimeId: runtimeId).capabilitySet
        async let model = capabilities.allows("catalog.model")
            ? connectorAPI.modelCatalog(connectorId: connectorId, runtimeId: runtimeId).catalog
            : V2ModelCatalog(runtime: runtimeId, revision: 0, models: [])
        async let permission = capabilities.allows("catalog.permission")
            ? connectorAPI.permissionCatalog(connectorId: connectorId, runtimeId: runtimeId).catalog
            : V2PermissionCatalog(runtime: runtimeId, revision: 0, permissions: [])
        return try await V2PreparedSession(
            runtime: runtime,
            capabilities: capabilities,
            catalogs: V2SessionCatalogs(model: model, permission: permission)
        )
    }

    func commands(connectorId: V2ConnectorID, runtimeId: V2RuntimeID) async throws -> [V2RuntimeCommand] {
        try await connectorAPI.commands(connectorId: connectorId, runtimeId: runtimeId).commands
    }
}
