import Foundation
import Observation

@MainActor
@Observable
final class DeviceManagementModel {
    private(set) var sessions: [V2SessionMeta] = []
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

    func updateSessions(connectorId: V2ConnectorID, allSessions: [V2SessionMeta]) {
        sessions = V2DeviceProjection.sessions(
            connectorId: connectorId,
            allSessions: allSessions
        )
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

}
