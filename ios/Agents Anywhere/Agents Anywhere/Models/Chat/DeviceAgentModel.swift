import Foundation
import Observation

/// Shared by device management and the post-pairing sheet. Types describe what
/// can be added; instances describe what actually exists on the device.
@MainActor @Observable
final class DeviceAgentModel {
    let connectorID: String
    private(set) var inventory = V2RuntimeInventory(types: [], instances: [])
    private(set) var isLoading = false
    private(set) var busyID: String?
    private(set) var error: String?
    private(set) var connected = false
    @ObservationIgnored private let service: V2DeviceManagementService
    @ObservationIgnored private var version = 0
    @ObservationIgnored private var isValid = true

    init(connectorID: String, service: V2DeviceManagementService) {
        self.connectorID = connectorID; self.service = service
    }
    var addableTypes: [V2RuntimeType] {
        inventory.types.filter { inventory.canAdd($0) }.sorted {
            if $0.recommended != $1.recommended { return $0.recommended }
            return ($0.recommendationRank ?? Int.max, $0.displayName) < ($1.recommendationRank ?? Int.max, $1.displayName)
        }
    }
    func updateConnection(_ connected: Bool) {
        self.connected = connected
        if !connected { version += 1; isLoading = false }
    }
    func refresh(discover: Bool = false) async {
        guard isValid, connected, !isLoading else { return }
        version += 1; let current = version
        isLoading = true
        defer { if current == version { isLoading = false } }
        do {
            let value = try await service.inventory(connectorId: connectorID, discover: discover)
            guard isValid, current == version, !Task.isCancelled else { return }
            inventory = value; error = nil
        } catch { if isValid, current == version, !Task.isCancelled { self.error = error.localizedDescription } }
    }
    func add(_ type: V2RuntimeType, name: String?, config: [String: JSONValue], newInstance: Bool = false) async throws {
        try await perform(type.id) {
            _ = try await service.addRuntime(connectorId: connectorID, type: type, name: name, config: config, newInstance: newInstance)
        }
    }
    func save(_ runtime: V2DeviceRuntime, config: [String: JSONValue]) async throws {
        try await perform(runtime.id) { _ = try await service.saveRuntimeConfig(connectorId: connectorID, runtimeId: runtime.id, config: config) }
    }
    func setActive(_ runtime: V2DeviceRuntime, _ active: Bool) async throws {
        try await perform(runtime.id) { _ = try await service.setRuntimeActive(connectorId: connectorID, runtimeId: runtime.id, active: active) }
    }
    func remove(_ runtime: V2DeviceRuntime) async throws {
        try await perform(runtime.id) { _ = try await service.deleteRuntimeConfig(connectorId: connectorID, runtimeId: runtime.id) }
    }
    func rename(_ runtime: V2DeviceRuntime, _ name: String) async throws {
        try await perform(runtime.id) { _ = try await service.renameRuntime(connectorId: connectorID, runtimeId: runtime.id, name: name) }
    }
    func schema(_ runtime: V2DeviceRuntime) throws -> V2RuntimeConfigSchema { try service.configSchema(runtime: runtime) }
    func schema(_ type: V2RuntimeType) throws -> V2RuntimeConfigSchema { try service.configSchema(type: type) }
    func dismissError() { error = nil }
    func invalidate() { isValid = false; version += 1; inventory = .init(types: [], instances: []); connected = false }

    private func perform(_ id: String, action: () async throws -> Void) async throws {
        guard isValid, connected else { throw URLError(.notConnectedToInternet) }
        guard busyID == nil else { throw V2BusinessError.workspaceFilesUnavailable(message: String(localized: "请等待当前 Agent 操作完成。")) }
        busyID = id; error = nil; version += 1; isLoading = false
        defer { busyID = nil }
        do {
            try await action()
            guard isValid else { throw CancellationError() }
            await refresh()
        } catch {
            let failure = error
            // A failed start may still have created the instance. Refresh before
            // exposing retry, and the service reads inventory again on each add.
            await refresh()
            if isValid { self.error = failure.localizedDescription }
            throw failure
        }
    }
}
