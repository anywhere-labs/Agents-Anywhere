import Foundation

struct V2DeviceManagementService {
    let connectorAPI: any V2ConnectorAPIProtocol

    func runtimes(connectorId: V2ConnectorID) async throws -> [V2DeviceRuntime] {
        try await connectorAPI.listRuntimes(connectorId: connectorId).runtimes
    }

    func discoverRuntimes(connectorId: V2ConnectorID) async throws -> [V2DeviceRuntime] {
        try await connectorAPI.discoverRuntimes(connectorId: connectorId).runtimes
    }

    func renameConnector(connectorId: V2ConnectorID, name: String) async throws -> V2Connector {
        let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedName.isEmpty else { throw V2BusinessError.emptyDeviceName }
        return try await connectorAPI.updateConnector(
            connectorId: connectorId,
            request: V2ConnectorUpdateRequest(name: normalizedName)
        ).connector
    }

    func revokeConnector(connectorId: V2ConnectorID) async throws -> V2ConnectorRevokeResponse {
        try await connectorAPI.revokeConnector(connectorId: connectorId)
    }

    func deleteConnector(connectorId: V2ConnectorID) async throws {
        try await connectorAPI.deleteConnector(connectorId: connectorId)
    }

    func saveRuntimeConfig(
        connectorId: V2ConnectorID,
        runtimeId: V2RuntimeID,
        config: [String: JSONValue]
    ) async throws -> V2DeviceRuntime {
        try await connectorAPI.updateRuntimeConfig(
            connectorId: connectorId,
            runtimeId: runtimeId,
            request: V2RuntimeConfigUpdateRequest(config: config)
        )
    }

    func configureAndStartRuntime(
        connectorId: V2ConnectorID,
        runtimeId: V2RuntimeID,
        config: [String: JSONValue]
    ) async throws -> V2DeviceRuntime {
        _ = try await saveRuntimeConfig(
            connectorId: connectorId,
            runtimeId: runtimeId,
            config: config
        )
        return try await setRuntimeActive(
            connectorId: connectorId,
            runtimeId: runtimeId,
            active: true
        )
    }

    func setRuntimeActive(
        connectorId: V2ConnectorID,
        runtimeId: V2RuntimeID,
        active: Bool
    ) async throws -> V2DeviceRuntime {
        try await connectorAPI.updateRuntimeActive(
            connectorId: connectorId,
            runtimeId: runtimeId,
            request: V2RuntimeActiveUpdateRequest(active: active)
        )
    }

    func deleteRuntimeConfig(
        connectorId: V2ConnectorID,
        runtimeId: V2RuntimeID
    ) async throws -> V2DeviceRuntime {
        try await connectorAPI.deleteRuntimeConfig(
            connectorId: connectorId,
            runtimeId: runtimeId
        )
    }

    func archiveSessions(
        connectorId: V2ConnectorID,
        archived: Bool,
        scope: V2ConnectorSessionArchiveScope
    ) async throws -> [V2SessionMeta] {
        try await connectorAPI.archiveSessions(
            connectorId: connectorId,
            request: V2ConnectorSessionArchiveRequest(
                archived: archived,
                scope: scope
            )
        ).sessions
    }

    func configSchema(runtime: V2DeviceRuntime) throws -> V2RuntimeConfigSchema {
        guard let schema = runtime.schema else {
            throw V2BusinessError.invalidRuntimeConfigSchema
        }
        return try V2RuntimeConfigSchema(schema: schema, uiSchema: runtime.uiSchema)
    }
}
