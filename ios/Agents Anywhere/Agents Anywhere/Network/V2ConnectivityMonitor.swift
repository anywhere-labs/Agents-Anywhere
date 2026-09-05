import Foundation
import Network
import Observation

nonisolated struct V2NetworkStatus: Hashable, Sendable {
    enum Availability: Hashable, Sendable { case unknown, online, offline }
    var availability: Availability = .unknown
    var isExpensive = false
    var isConstrained = false
}

/// Path availability is a scheduling hint, not proof that this server is reachable.
@MainActor @Observable
final class V2ConnectivityMonitor {
    private(set) var status = V2NetworkStatus()
    @ObservationIgnored private var monitor: NWPathMonitor?
    @ObservationIgnored var onChange: ((V2NetworkStatus) -> Void)?

    func start() {
        guard monitor == nil else { return }
        let monitor = NWPathMonitor()
        self.monitor = monitor
        monitor.pathUpdateHandler = { [weak self, weak monitor] path in
            let status = V2NetworkStatus(
                availability: path.status == .satisfied ? .online : .offline,
                isExpensive: path.isExpensive, isConstrained: path.isConstrained
            )
            Task { @MainActor in
                guard let self, let monitor, self.monitor === monitor else { return }
                self.status = status
                self.onChange?(status)
            }
        }
        monitor.start(queue: DispatchQueue(label: "app.agentsanywhere.connectivity"))
    }

    func stop() { monitor?.cancel(); monitor = nil }
}
