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
        async let capabilities = connectorAPI.runtimeCapabilities(connectorId: connectorId, runtimeId: runtimeId)
        async let model = connectorAPI.modelCatalog(connectorId: connectorId, runtimeId: runtimeId)
        async let permission = connectorAPI.permissionCatalog(connectorId: connectorId, runtimeId: runtimeId)
        return try await V2PreparedSession(
            runtime: runtime,
            capabilities: capabilities.capabilitySet,
            catalogs: V2SessionCatalogs(model: model.catalog, permission: permission.catalog)
        )
    }

    func commands(connectorId: V2ConnectorID, runtimeId: V2RuntimeID) async throws -> [V2RuntimeCommand] {
        try await connectorAPI.commands(connectorId: connectorId, runtimeId: runtimeId).commands
    }
}
