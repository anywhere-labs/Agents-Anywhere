import AAClientCore
import Foundation
import Observation

/// A device page: live `watch_list`, `Device/status` (agents) and terminals, with the cache when offline.
@MainActor
@Observable
final class DeviceModel {
    let deviceID: String
    private(set) var list = SessionList()
    private(set) var status: DeviceStatus?
    private(set) var terminals: [TerminalInfo] = []
    private(set) var live = false
    private(set) var error: String?
    private(set) var needsPairing = false
    private weak var app: AppModel?
    private var task: Task<Void, Never>?

    init(app: AppModel, deviceID: String) {
        self.app = app
        self.deviceID = deviceID
    }

    var groups: [AgentGroup] { AgentGroup.group(list.sessions) }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in await self?.run() }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    private func run() async {
        guard let services = app?.services else { return }
        if let cached = await services.cache.sessionList(deviceID: deviceID) { list = cached }
        var delay: Double = 1
        while !Task.isCancelled {
            guard let app, let device = app.device(deviceID), device.isOnline else {
                live = false
                error = "设备离线，显示的是上次的列表"
                try? await Task.sleep(for: .seconds(3))
                continue
            }
            do {
                if status == nil { Task { await self.refreshStatus() } }
                for try await event in services.tunnels.watchList(deviceID) {
                    list = event.list
                    live = true
                    error = nil
                    needsPairing = false
                    delay = 1
                    app.updateDeviceList(event.list, deviceID: deviceID)
                    await services.cache.saveSessionList(event.list, deviceID: deviceID)
                }
            } catch {
                if Task.isCancelled { return }
                live = false
                if let pairing = error as? PairingError, [.e2eNotPaired, .e2eHandshakeFailed].contains(pairing.code) {
                    needsPairing = true
                }
                self.error = AppModel.describe(error)
            }
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, 20)
        }
    }

    func refreshStatus() async {
        guard let services = app?.services else { return }
        do {
            status = try await services.tunnels.status(deviceID)
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    func refreshTerminals() async {
        guard let services = app?.services else { return }
        do {
            terminals = try await services.tunnels.listTerminals(deviceID).sorted { $0.createdAt > $1.createdAt }
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    func createTerminal() async -> TerminalInfo? {
        guard let services = app?.services else { return nil }
        do {
            let terminal = try await services.tunnels.createTerminal(deviceID)
            terminals.insert(terminal, at: 0)
            app?.createdTerminals.insert(terminal.id)
            return terminal
        } catch {
            self.error = AppModel.describe(error)
            return nil
        }
    }

    func closeTerminal(_ id: String) async {
        guard let services = app?.services else { return }
        do {
            try await services.tunnels.closeTerminal(deviceID, terminalID: id)
            terminals.removeAll { $0.id == id }
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    func delete(_ session: SessionSummary) async {
        guard let services = app?.services else { return }
        do {
            try await services.tunnels.deleteSession(deviceID, sessionID: session.id)
        } catch {
            self.error = AppModel.describe(error)
        }
    }
}
