import Foundation
import Observation

/// Pairing observation belongs to the account, not the lifetime of a sheet.
/// Background/offline transitions pause reads and retain the pending devices.
@MainActor @Observable
final class AgentSetupCoordinator {
    struct Request: Identifiable {
        var connector: V2Connector
        var ready = false
        var error: String?
        var id: String { connector.id }
    }
    private(set) var requests: [Request] = []
    var pairingFormPresented = false
    @ObservationIgnored var onOnline: ((V2Connector) -> Void)?
    @ObservationIgnored private let service: V2DevicePairingService
    @ObservationIgnored private let sleep: (Duration) async throws -> Void
    @ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var isActive = true
    @ObservationIgnored private var isOnline = true
    @ObservationIgnored private var isValid = true
    @ObservationIgnored private var generation = 0

    init(service: V2DevicePairingService, sleep: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.service = service; self.sleep = sleep
    }
    var presentedConnector: V2Connector? {
        guard !pairingFormPresented else { return nil }
        return requests.first { $0.ready }?.connector
    }
    func watch(_ connector: V2Connector) {
        guard isValid else { return }
        if !requests.contains(where: { $0.id == connector.id }) { requests.append(.init(connector: connector)) }
        if connector.status == .online { markReady(connector) }
        resume()
    }
    func updateConnectors(_ connectors: [V2Connector]) {
        for connector in connectors where connector.status == .online {
            if requests.contains(where: { $0.id == connector.id && !$0.ready }) { markReady(connector) }
        }
    }
    func finish(_ id: String) { tasks.removeValue(forKey: id)?.cancel(); requests.removeAll { $0.id == id } }
    func retry(_ id: String) {
        if let index = requests.firstIndex(where: { $0.id == id }) { requests[index].error = nil }
        resume()
    }
    func setActive(_ active: Bool) { isActive = active; restart() }
    func updateNetwork(_ network: V2NetworkStatus) { isOnline = network.availability != .offline; restart() }
    func invalidate() {
        isValid = false; pause(); requests = []; onOnline = nil
    }
    private func restart() { pause(); resume() }
    private func pause() {
        generation += 1
        tasks.values.forEach { $0.cancel() }; tasks = [:]
    }
    private func resume() {
        guard isValid, isOnline, isActive else { return }
        for request in requests where !request.ready && request.error == nil && tasks[request.id] == nil {
            let version = generation
            tasks[request.id] = Task { [weak self] in await self?.poll(request.id, version: version) }
        }
    }
    private func poll(_ id: String, version: Int) async {
        defer { if version == generation { tasks[id] = nil } }
        while current(id, version) {
            do {
                let connector = try await service.connector(connectorId: id)
                guard current(id, version) else { return }
                if connector.status == .online {
                    markReady(connector); onOnline?(connector); return
                }
                try await sleep(.seconds(2))
            } catch {
                guard current(id, version) else { return }
                let failure = V2ClientFailure(error)
                if failure.kind == .unavailable { finish(id); return }
                if !failure.permitsAutomaticReconnect {
                    if let index = requests.firstIndex(where: { $0.id == id }) { requests[index].error = failure.message }
                    return
                }
                do { try await sleep(.seconds(3)) } catch { return }
            }
        }
    }
    private func current(_ id: String, _ version: Int) -> Bool {
        isValid && isActive && isOnline && version == generation && !Task.isCancelled
            && requests.contains { $0.id == id && !$0.ready }
    }
    private func markReady(_ connector: V2Connector) {
        guard let index = requests.firstIndex(where: { $0.id == connector.id }) else { return }
        requests[index].connector = connector; requests[index].ready = true; requests[index].error = nil
        tasks.removeValue(forKey: connector.id)?.cancel()
    }
}
