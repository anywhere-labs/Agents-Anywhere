import Foundation
import Observation

/// Server-owned switches for one device. A change moves the switch at once and
/// keeps it disabled until the Server answers; a failed write puts the previous
/// value back. A read that is still in flight never overwrites a write.
@MainActor @Observable
final class DeviceSettingsModel {
    enum SaveOutcome: Equatable {
        /// The online Connector confirmed the change.
        case applied
        /// Saved on the Server; the device applies it once it is online.
        case pendingDelivery
        case failed(V2ClientFailure)
    }

    private(set) var settings: V2ConnectorDeviceSettings?
    private(set) var isLoading = false
    private(set) var isSaving = false
    private(set) var loadError: V2ClientFailure?
    @ObservationIgnored private var connectorID: V2ConnectorID?
    @ObservationIgnored private var version = 0

    func load(connectorId: V2ConnectorID, service: V2DeviceManagementService) async {
        if connectorID != connectorId {
            connectorID = connectorId; settings = nil; loadError = nil
        }
        guard !isSaving else { return }
        version += 1; let current = version
        isLoading = true
        defer { if current == version { isLoading = false } }
        do {
            let response = try await service.deviceSettings(connectorId: connectorId)
            guard current == version, !Task.isCancelled else { return }
            settings = response.settings; loadError = nil
        } catch {
            guard current == version, !Task.isCancelled else { return }
            let failure = V2ClientFailure(error)
            if failure.kind != .cancelled { loadError = failure }
        }
    }

    /// Returns `nil` when nothing was sent: no loaded value, another write in
    /// flight, or the switch already has this value.
    func setConfirmQuitOnShutdown(
        _ value: Bool,
        connectorId: V2ConnectorID,
        service: V2DeviceManagementService
    ) async -> SaveOutcome? {
        guard connectorID == connectorId, let previous = settings, !isSaving,
              previous.confirmQuitOnShutdown != value else { return nil }
        // Drop any read in flight so it cannot undo the write.
        version += 1; isLoading = false
        isSaving = true
        defer { isSaving = false }
        var next = previous
        next.confirmQuitOnShutdown = value
        settings = next
        do {
            let response = try await service.updateDeviceSettings(
                connectorId: connectorId,
                V2ConnectorDeviceSettingsPatch(confirmQuitOnShutdown: value)
            )
            settings = response.settings; loadError = nil
            return response.delivered == false ? .pendingDelivery : .applied
        } catch {
            settings = previous
            return .failed(V2ClientFailure(error))
        }
    }
}
