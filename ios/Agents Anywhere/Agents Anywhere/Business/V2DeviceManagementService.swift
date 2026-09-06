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

    func inventory(connectorId: V2ConnectorID, discover: Bool = false) async throws -> V2RuntimeInventory {
        let types = try await (discover
            ? connectorAPI.discoverRuntimeTypes(connectorId: connectorId)
            : connectorAPI.runtimeTypes(connectorId: connectorId))
        let instances = try await connectorAPI.listRuntimes(connectorId: connectorId)
        return V2RuntimeInventory(types: types.runtimeTypes, instances: instances.runtimes)
    }

    /// Retry uses current server inventory, including instances persisted by a
    /// previous create whose startup/response failed. Writes are never replayed.
    func addRuntime(connectorId: String, type: V2RuntimeType, name: String?, config: [String: JSONValue], newInstance: Bool = false) async throws -> V2DeviceRuntime {
        let inventory = try await inventory(connectorId: connectorId)
        guard let currentType = inventory.types.first(where: { $0.id == type.id }), currentType.present else {
            throw V2BusinessError.workspaceFilesUnavailable(message: "这个 Agent 已不可用，请刷新设备。")
        }
        let configured = inventory.configuredInstances.first { $0.runtimeType == type.runtimeType }
        // A named create retry can recover exactly that instance without adding another.
        let named = name.flatMap { name in inventory.instances.first { $0.runtimeType == type.runtimeType && $0.name == name } }
        let existing = named ?? (newInstance ? nil : configured) ?? inventory.reconfigurableInstance(for: currentType)
        if let existing {
            if existing.configured && existing.active && [.running, .starting].contains(existing.status) { return existing }
            if !existing.configured {
                _ = try await saveRuntimeConfig(connectorId: connectorId, runtimeId: existing.id, config: config)
            }
            return try await setRuntimeActive(connectorId: connectorId, runtimeId: existing.id, active: true)
        }
        guard inventory.canAdd(currentType) else {
            throw V2BusinessError.workspaceFilesUnavailable(message: "这个 Agent 的实例数量已达上限。")
        }
        let names = Set(inventory.instances.map { $0.name.lowercased() })
        var suggestion = currentType.displayName
        var suffix = 2
        while names.contains(suggestion.lowercased()) { suggestion = "\(currentType.displayName) \(suffix)"; suffix += 1 }
        return try await createRuntime(connectorId: connectorId, runtimeType: currentType.runtimeType,
            name: name ?? suggestion, config: config, active: true)
    }

    /// Creation is atomic at the API boundary: never persist an empty placeholder instance.
    func createRuntime(connectorId: V2ConnectorID, runtimeType: String, name: String, config: [String: JSONValue], active: Bool = true) async throws -> V2DeviceRuntime {
        let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedName.isEmpty else { throw V2BusinessError.emptyDeviceName }
        return try await connectorAPI.createRuntime(
            connectorId: connectorId,
            request: V2RuntimeInstanceCreateRequest(runtimeType: runtimeType, name: normalizedName, config: config, active: active)
        )
    }

    func renameRuntime(connectorId: V2ConnectorID, runtimeId: V2RuntimeID, name: String) async throws -> V2DeviceRuntime {
        let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedName.isEmpty else { throw V2BusinessError.emptyDeviceName }
        return try await connectorAPI.renameRuntime(
            connectorId: connectorId, runtimeId: runtimeId,
            request: V2RuntimeInstanceRenameRequest(name: normalizedName)
        )
    }

    func preferences(connectorId: V2ConnectorID) async throws -> [String: JSONValue] {
        try await connectorAPI.preferences(connectorId: connectorId).preferences
    }

    func configSchema(runtime: V2DeviceRuntime) throws -> V2RuntimeConfigSchema {
        guard let schema = runtime.schema else { throw V2BusinessError.invalidRuntimeConfigSchema }
        return try V2RuntimeConfigSchema(schema: schema, uiSchema: runtime.uiSchema, defaults: runtime.defaults)
    }

    func configSchema(type: V2RuntimeType) throws -> V2RuntimeConfigSchema {
        guard let schema = type.configSchema?.schema ?? type.schema else {
            throw V2BusinessError.invalidRuntimeConfigSchema
        }
        return try V2RuntimeConfigSchema(
            schema: schema,
            uiSchema: type.configSchema?.uiSchema ?? type.uiSchema,
            defaults: type.configSchema?.defaults ?? type.defaults
        )
    }
}
