import Foundation
import Observation

@MainActor
@Observable
final class DeviceManagementModel {
    private(set) var runtimes: [V2DeviceRuntime] = []
    private(set) var sessions: [V2SessionMeta] = []
    private(set) var workspaces: [V2DeviceWorkspace] = []
    private(set) var isLoadingRuntimes = false
    private(set) var isDiscoveringRuntimes = false
    private(set) var busyRuntimeId: V2RuntimeID?
    private(set) var isDeviceActionRunning = false
    private(set) var isArchiveActionRunning = false
    var sessionFilter = V2DeviceSessionFilter.active
    var selectedSessionIds: Set<V2SessionID> = []
    var isSelectingSessions = false
    var errorMessage: String?

    var filteredSessions: [V2SessionMeta] {
        sessions.filter { session in
            switch sessionFilter {
            case .active:
                !session.archived
            case .archived:
                session.archived
            case .all:
                true
            }
        }
    }

    var configuredRuntimes: [V2DeviceRuntime] {
        runtimes
            .filter(\.configured)
            .sorted(by: runtimeDisplayNameAscending)
    }

    var availableRuntimes: [V2DeviceRuntime] {
        runtimes
            .filter { $0.present && !$0.configured }
            .sorted(by: runtimeDisplayNameAscending)
    }

    func updateSessions(connectorId: V2ConnectorID, allSessions: [V2SessionMeta]) {
        sessions = V2DeviceProjection.sessions(
            connectorId: connectorId,
            allSessions: allSessions
        )
        workspaces = V2DeviceProjection.workspaces(sessions: sessions)
        selectedSessionIds.formIntersection(Set(sessions.map(\.id)))
    }

    func setSessionFilter(_ filter: V2DeviceSessionFilter) {
        sessionFilter = filter
        selectedSessionIds.removeAll()
    }

    func toggleSessionSelection(_ sessionId: V2SessionID) {
        if selectedSessionIds.contains(sessionId) {
            selectedSessionIds.remove(sessionId)
        } else {
            selectedSessionIds.insert(sessionId)
        }
    }

    func stopSelectingSessions() {
        isSelectingSessions = false
        selectedSessionIds.removeAll()
    }

    func startSelectingSessions() {
        isSelectingSessions = true
    }

    func dismissError() {
        errorMessage = nil
    }

    /// Loads the server-owned runtime inventory for the selected device.
    func loadRuntimes(
        connectorId: V2ConnectorID,
        service: V2DeviceManagementService
    ) async {
        guard !isLoadingRuntimes else { return }
        isLoadingRuntimes = true
        defer { isLoadingRuntimes = false }
        do {
            runtimes = try await service.runtimes(connectorId: connectorId)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Asks the Connector to rediscover local Agent runtimes and replaces the inventory.
    func discoverRuntimes(
        connectorId: V2ConnectorID,
        service: V2DeviceManagementService
    ) async {
        guard !isDiscoveringRuntimes else { return }
        isDiscoveringRuntimes = true
        defer { isDiscoveringRuntimes = false }
        do {
            runtimes = try await service.discoverRuntimes(connectorId: connectorId)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Persists the edited device name and returns the server-authoritative Connector.
    func renameConnector(
        connectorId: V2ConnectorID,
        name: String,
        service: V2DeviceManagementService
    ) async -> V2Connector? {
        guard !isDeviceActionRunning else { return nil }
        isDeviceActionRunning = true
        defer { isDeviceActionRunning = false }
        do {
            let connector = try await service.renameConnector(
                connectorId: connectorId,
                name: name
            )
            errorMessage = nil
            return connector
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Rotates the Connector credential and disconnects the current desktop process.
    func revokeConnector(
        connectorId: V2ConnectorID,
        service: V2DeviceManagementService
    ) async -> V2ConnectorRevokeResponse? {
        guard !isDeviceActionRunning else { return nil }
        isDeviceActionRunning = true
        defer { isDeviceActionRunning = false }
        do {
            let response = try await service.revokeConnector(connectorId: connectorId)
            errorMessage = nil
            return response
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    /// Permanently deletes the device and its server-owned metadata.
    func deleteConnector(
        connectorId: V2ConnectorID,
        service: V2DeviceManagementService
    ) async -> Bool {
        guard !isDeviceActionRunning else { return false }
        isDeviceActionRunning = true
        defer { isDeviceActionRunning = false }
        do {
            try await service.deleteConnector(connectorId: connectorId)
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Saves a runtime configuration, optionally starting an unconfigured runtime afterward.
    func saveRuntimeConfig(
        connectorId: V2ConnectorID,
        runtime: V2DeviceRuntime,
        config: [String: JSONValue],
        startAfterSaving: Bool,
        service: V2DeviceManagementService
    ) async throws {
        guard busyRuntimeId == nil else { return }
        busyRuntimeId = runtime.id
        defer { busyRuntimeId = nil }
        let updated = if startAfterSaving {
            try await service.configureAndStartRuntime(
                connectorId: connectorId,
                runtimeId: runtime.id,
                config: config
            )
        } else {
            try await service.saveRuntimeConfig(
                connectorId: connectorId,
                runtimeId: runtime.id,
                config: config
            )
        }
        replaceRuntime(updated)
        errorMessage = nil
    }

    /// Starts or stops a configured runtime on the Connector.
    func setRuntimeActive(
        connectorId: V2ConnectorID,
        runtime: V2DeviceRuntime,
        active: Bool,
        service: V2DeviceManagementService
    ) async {
        guard busyRuntimeId == nil else { return }
        busyRuntimeId = runtime.id
        defer { busyRuntimeId = nil }
        do {
            let updated = try await service.setRuntimeActive(
                connectorId: connectorId,
                runtimeId: runtime.id,
                active: active
            )
            replaceRuntime(updated)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Deletes the saved runtime configuration and updates the runtime inventory.
    func deleteRuntimeConfig(
        connectorId: V2ConnectorID,
        runtime: V2DeviceRuntime,
        service: V2DeviceManagementService
    ) async {
        guard busyRuntimeId == nil else { return }
        busyRuntimeId = runtime.id
        defer { busyRuntimeId = nil }
        do {
            let updated = try await service.deleteRuntimeConfig(
                connectorId: connectorId,
                runtimeId: runtime.id
            )
            replaceRuntime(updated)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Archives or restores every session in the current filter scope.
    func archiveSessions(
        connectorId: V2ConnectorID,
        archived: Bool,
        service: V2DeviceManagementService
    ) async -> [V2SessionMeta]? {
        guard !isArchiveActionRunning else { return nil }
        isArchiveActionRunning = true
        defer { isArchiveActionRunning = false }
        do {
            let updated = try await service.archiveSessions(
                connectorId: connectorId,
                archived: archived,
                scope: sessionFilter.archiveScope
            )
            errorMessage = nil
            return updated
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func configSchema(
        runtime: V2DeviceRuntime,
        service: V2DeviceManagementService
    ) -> V2RuntimeConfigSchema? {
        do {
            return try service.configSchema(runtime: runtime)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    private func replaceRuntime(_ updated: V2DeviceRuntime) {
        if let index = runtimes.firstIndex(where: { $0.id == updated.id }) {
            runtimes[index] = updated
        } else {
            runtimes.append(updated)
        }
    }

    private func runtimeDisplayNameAscending(
        _ left: V2DeviceRuntime,
        _ right: V2DeviceRuntime
    ) -> Bool {
        left.displayName.localizedStandardCompare(right.displayName) == .orderedAscending
    }
}
