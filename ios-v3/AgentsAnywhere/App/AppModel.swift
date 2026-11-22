import AAClientCore
import Foundation
import Observation
import SwiftUI

/// Account-scoped services. Built on sign-in (or restore), dropped on sign-out.
struct AppServices {
    let auth: AuthSession
    let control: ControlPlaneClient
    let tunnels: DeviceTunnelPool
    let trust: TrustStore
    let identity: ClientIdentityStore
    let cache: LocalCache
    let accountID: String
}

enum LockBadge {
    case none
    /// Paired end to end from this app (independently distributed client: green).
    case green
    /// Encrypted device not yet paired here.
    case unpaired
}

@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        case launching
        case signedOut
        case signedIn
    }

    private(set) var phase: Phase = .launching
    private(set) var services: AppServices?
    private(set) var account: StoredAccount?

    private(set) var devices: [DeviceRecord] = []
    /// Live device feed state: nil while connected, else why it is not.
    private(set) var devicesError: String?
    private(set) var devicesLoaded = false
    private(set) var merger = SessionMerger()
    private(set) var refreshingSessions = false
    /// Bumped when trust records change, so views re-read them.
    private(set) var trustRevision = 0

    var path = NavigationPath()
    var selection: SidebarItem?
    var showingNewConversation = false
    var showingSettings = false
    var pairingTarget: PairingTarget?

    let secrets: any SecretStore = KeychainStore()
    private var watchTask: Task<Void, Never>?

    var recentSessions: [SessionSummary] { merger.sessions }

    // MARK: Lifecycle

    func start() async {
        guard phase == .launching else { return }
        if let auth = AuthSession.restore(store: secrets) {
            await activate(auth)
        } else {
            phase = .signedOut
        }
        #if DEBUG
        await DebugLaunch.run(self)
        #endif
    }

    func signIn(controlURL: String, email: String, password: String) async throws {
        let auth = try await AuthSession.signIn(controlURL: controlURL, email: email, password: password, store: secrets)
        await activate(auth)
    }

    private func activate(_ auth: AuthSession) async {
        let account = await auth.current
        let control = ControlPlaneClient(auth: auth)
        let trust = TrustStore(store: secrets, accountID: account.user.id)
        let identity = ClientIdentityStore(store: secrets)
        let services = AppServices(
            auth: auth, control: control, tunnels: DeviceTunnelPool(issuer: control, trust: trust, identity: identity),
            trust: trust, identity: identity, cache: LocalCache.forAccount(account.user.id), accountID: account.user.id)
        self.services = services
        self.account = account
        // Offline first: show what we last saw, then go live.
        devices = await services.cache.devices()
        let lists = await services.cache.allSessionLists(deviceIDs: devices.map(\.id))
        merger = SessionMerger(cache: lists, localE2EE: Set(trust.all().keys))
        phase = .signedIn
        startWatchingDevices()
        Task { await refreshSessions() }
    }

    func signOut() async {
        watchTask?.cancel()
        watchTask = nil
        if let services {
            await services.tunnels.closeAll()
            await services.control.close()
            await services.auth.signOut()
        }
        services = nil
        account = nil
        devices = []
        merger = SessionMerger()
        path = NavigationPath()
        selection = nil
        phase = .signedOut
    }

    /// The app came back to the foreground: drop sockets the system cut, refresh lists.
    func foreground() {
        guard let services else { return }
        Task {
            await services.control.checkConnection()
            await services.tunnels.checkConnections()
            await refreshSessions()
        }
    }

    // MARK: Devices

    private func startWatchingDevices() {
        watchTask?.cancel()
        watchTask = Task { [weak self] in
            var delay: Double = 1
            while !Task.isCancelled {
                guard let services = self?.services else { return }
                do {
                    for try await event in services.control.watchDevices() {
                        guard let self else { return }
                        self.devices = event.apply(to: self.devices)
                        self.devicesError = nil
                        self.devicesLoaded = true
                        delay = 1
                        await services.tunnels.updateDevices(self.devices)
                        await services.cache.saveDevices(self.devices)
                    }
                } catch {
                    if Task.isCancelled { return }
                    if let rejected = error as? ControlAPIError, rejected.isAuthRejection {
                        await self?.signOut()
                        return
                    }
                    self?.devicesError = Self.describe(error)
                }
                try? await Task.sleep(for: .seconds(delay))
                delay = min(delay * 2, 30)
            }
        }
    }

    func device(_ id: String) -> DeviceRecord? { devices.first { $0.id == id } }

    func lockBadge(for device: DeviceRecord) -> LockBadge {
        _ = trustRevision
        if let record = services?.trust.record(for: device.id), record.confirmed { return .green }
        return device.isEncryptedHint ? .unpaired : .none
    }

    func trustRecords() -> [DeviceTrustRecord] {
        _ = trustRevision
        return services?.trust.all().values.sorted { $0.pairedAt > $1.pairedAt } ?? []
    }

    func trustChanged() {
        trustRevision += 1
        merger.localE2EE = Set(services?.trust.all().keys.map { $0 } ?? [])
    }

    // MARK: Sessions

    /// Control-plane fan-out for normal devices, plus this client's own tunnels to paired encrypted devices.
    func refreshSessions() async {
        guard let services, !refreshingSessions else { return }
        refreshingSessions = true
        defer { refreshingSessions = false }
        merger.localE2EE = Set(services.trust.all().keys)
        do {
            for try await result in services.control.listSessions(limitPerDevice: 100) {
                merger.apply(result, from: .controlPlane)
                if result.status == "ok", let list = result.value { await services.cache.saveSessionList(list, deviceID: result.deviceID) }
            }
        } catch {
            devicesError = devicesError ?? Self.describe(error)
        }
        for record in services.trust.all().values where record.confirmed {
            guard device(record.deviceID)?.isOnline ?? false else { continue }
            do {
                let list = try await services.tunnels.listSessions(record.deviceID, limit: 100)
                merger.apply(DeviceSessionResult(deviceID: record.deviceID, status: "ok", value: list), from: .clientTunnel)
                await services.cache.saveSessionList(list, deviceID: record.deviceID)
            } catch {
                let code = (error as? PairingError)?.code.rawValue ?? "error"
                merger.apply(
                    DeviceSessionResult(deviceID: record.deviceID, status: "error", error: DeviceError(code: code, message: Self.describe(error))),
                    from: .clientTunnel)
            }
        }
    }

    /// A device page's live list replaces that device's slice.
    func updateDeviceList(_ list: SessionList, deviceID: String) {
        merger.apply(DeviceSessionResult(deviceID: deviceID, status: "ok", value: list), from: .clientTunnel)
    }

    func sessions(for deviceID: String) -> [SessionSummary] {
        merger.sessions.filter { $0.deviceID == deviceID }
    }

    // MARK: Navigation

    func open(_ route: Route) {
        path.append(route)
    }

    static func describe(_ error: Error) -> String {
        if let error = error as? PairingError { return error.message }
        if let error = error as? ControlAPIError { return error.message }
        if let error = error as? MeshCallError {
            switch error.code {
            case .unavailable: return "连接不上（\(error.message)）"
            case .deadlineExceeded: return "请求超时"
            case .unauthenticated: return "凭据已失效，请重试"
            default: return error.message
            }
        }
        if let error = error as? URLError {
            switch error.code {
            case .notConnectedToInternet, .networkConnectionLost: return "网络不可用"
            case .cannotConnectToHost, .cannotFindHost: return "连不上控制面"
            case .timedOut: return "请求超时"
            default: return error.localizedDescription
            }
        }
        return error.localizedDescription
    }
}

enum SidebarItem: Hashable {
    case device(String)
    case conversation(deviceID: String, sessionID: String)
}

enum Route: Hashable {
    case device(String)
    case conversation(deviceID: String, sessionID: String)
    case terminal(deviceID: String, terminalID: String)
}

struct PairingTarget: Identifiable {
    var id: String { deviceID ?? "any" }
    var deviceID: String?
}
