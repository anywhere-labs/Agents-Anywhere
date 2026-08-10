import Combine
import Foundation
#if os(iOS)
import UIKit
#endif

@MainActor
final class AppState: ObservableObject {
    enum Route {
        case loading
        case signedOut
        case signedIn
    }

    enum ServerConnectionIssue: String, Identifiable {
        case unavailable

        var id: String { rawValue }
    }

    @Published private(set) var route: Route = .loading
    @Published private(set) var serverURL: URL?
    @Published private(set) var me: AuthMe? {
        didSet {
            accountAvatarSource = AccountAvatarImageSource.parse(me?.avatar)
        }
    }
    @Published private(set) var accountAvatarSource: AccountAvatarImageSource?
    @Published private(set) var connectors: [V2Connector] = []
    @Published private(set) var sessions: [V2SessionMeta] = []
    @Published private(set) var isDashboardLoading = false
    @Published private(set) var hasLoadedConnectors = false
    @Published private(set) var hasLoadedSessions = false
    @Published var authError: String?
    @Published var dashboardError: String?
    @Published var sessionsError: String?
    @Published var connectorsError: String?
    @Published var isWorking = false
    @Published private(set) var serverConnectionIssue: ServerConnectionIssue?
    @Published private(set) var isRetryingServerConnection = false
    @Published private(set) var sessionActionError: String?
    @Published private(set) var isAccountWorking = false
    @Published private(set) var accountError: String?

    private let keychain = KeychainStore()
    private let serverDefaultsKey = "agentsAnywhere.serverURL"
    private let tokenAccount = "accessToken"
    private let dashboardClientId = "ios-dashboard-\(UUID().uuidString)"
    private var lastDashboardRefreshAt: Date?
    private var dashboardUpdatesTask: Task<Void, Never>?

    init() {
        Task { await restoreSession() }
    }

    var api: APIClient? {
        guard let serverURL else { return nil }
        return APIClient(serverURL: serverURL)
    }

    func accessToken() -> String? {
        try? keychain.readString(account: tokenAccount)
    }

    func restoreSession() async {
        route = .loading
        guard
            let serverValue = UserDefaults.standard.string(forKey: serverDefaultsKey),
            let serverURL = URL(string: serverValue),
            let token = try? keychain.readString(account: tokenAccount),
            !token.isEmpty
        else {
            route = .signedOut
            return
        }

        self.serverURL = serverURL
        do {
            try await restoreAuthenticatedSession(serverURL: serverURL, token: token)
        } catch {
            handleSessionRestoreFailure(error)
        }
    }

    /// Performs network I/O to restore the saved session after a connection failure.
    func retryServerConnection() async {
        guard !isRetryingServerConnection else { return }
        guard
            let serverURL,
            let token = try? keychain.readString(account: tokenAccount),
            !token.isEmpty
        else {
            returnToLogin()
            return
        }

        isRetryingServerConnection = true
        defer { isRetryingServerConnection = false }

        do {
            try await restoreAuthenticatedSession(serverURL: serverURL, token: token)
        } catch {
            handleSessionRestoreFailure(error)
        }
    }

    func returnToLogin() {
        signOut()
    }

    func checkServer(_ value: String) async -> URL? {
        authError = nil
        isWorking = true
        defer { isWorking = false }
        do {
            let url = try URL.agentsServer(from: value)
            let client = APIClient(serverURL: url)
            _ = try await client.health()
            _ = try await client.authConfig()
            return url
        } catch {
            authError = error.localizedDescription
            return nil
        }
    }

    func login(serverURL: URL, userId: String, password: String) async {
        authError = nil
        isWorking = true
        defer { isWorking = false }
        do {
            let client = APIClient(serverURL: serverURL)
            let auth = try await client.login(userId: userId, password: password)
            try saveSession(serverURL: serverURL, token: auth.accessToken)
            self.serverURL = serverURL
            me = try await client.me(token: auth.accessToken)
            route = .signedIn
            await refreshDashboard()
            startDashboardUpdates()
        } catch {
            authError = error.localizedDescription
        }
    }

    func verifyPasswordLogin(serverURL: URL, userId: String, password: String) async -> AuthResponse? {
        authError = nil
        isWorking = true
        defer { isWorking = false }
        do {
            let client = APIClient(serverURL: serverURL)
            return try await client.login(userId: userId, password: password)
        } catch {
            authError = error.localizedDescription
            return nil
        }
    }

    func completePasswordLogin(serverURL: URL, auth: AuthResponse, showSignedInRoute: Bool = true) async {
        authError = nil
        isWorking = true
        defer { isWorking = false }
        do {
            let client = APIClient(serverURL: serverURL)
            try saveSession(serverURL: serverURL, token: auth.accessToken)
            self.serverURL = serverURL
            me = try await client.me(token: auth.accessToken)
            if showSignedInRoute {
                route = .signedIn
                await refreshDashboard()
                startDashboardUpdates()
            }
        } catch {
            authError = error.localizedDescription
        }
    }

    func completeOAuthLogin(serverURL: URL, token: OAuthTokenResponse, showSignedInRoute: Bool = true) async {
        authError = nil
        isWorking = true
        defer { isWorking = false }
        do {
            let client = APIClient(serverURL: serverURL)
            try saveSession(serverURL: serverURL, token: token.accessToken)
            self.serverURL = serverURL
            me = try await client.me(token: token.accessToken)
            if showSignedInRoute {
                route = .signedIn
                await refreshDashboard()
                startDashboardUpdates()
            }
        } catch {
            authError = error.localizedDescription
        }
    }

    func requestMobileLogin(payload: MobileLoginPayload) async -> Bool {
        authError = nil
        isWorking = true
        defer { isWorking = false }
        do {
            let serverURL = try URL.agentsServer(from: payload.webUrl)
            let client = APIClient(serverURL: serverURL)
            _ = try await client.requestMobileLogin(
                payload: payload,
                deviceName: currentDeviceName(),
            )
            self.serverURL = serverURL
            return true
        } catch {
            authError = error.localizedDescription
            return false
        }
    }

    func mobileLoginStatus(payload: MobileLoginPayload) async -> MobileLoginStatusResponse? {
        authError = nil
        do {
            let serverURL = try URL.agentsServer(from: payload.webUrl)
            let client = APIClient(serverURL: serverURL)
            return try await client.mobileLoginStatus(payload: payload)
        } catch {
            authError = error.localizedDescription
            return nil
        }
    }

    func exchangeMobileLogin(payload: MobileLoginPayload, showSignedInRoute: Bool = true) async {
        authError = nil
        isWorking = true
        defer { isWorking = false }
        do {
            let serverURL = try URL.agentsServer(from: payload.webUrl)
            let client = APIClient(serverURL: serverURL)
            let exchange = try await client.exchangeMobileLogin(payload: payload)
            try saveSession(serverURL: serverURL, token: exchange.auth.accessToken)
            self.serverURL = serverURL
            me = try await client.me(token: exchange.auth.accessToken)
            if showSignedInRoute {
                route = .signedIn
                await refreshDashboard()
                startDashboardUpdates()
            }
        } catch {
            authError = error.localizedDescription
        }
    }

    func refreshDashboardIfStale(minimumInterval: TimeInterval = 1.5) async {
        if isDashboardLoading { return }
        if let lastDashboardRefreshAt,
           Date().timeIntervalSince(lastDashboardRefreshAt) < minimumInterval
        {
            return
        }
        await refreshDashboard()
    }

    func refreshDashboard() async {
        guard let services = makeV2Services() else { return }
        if isDashboardLoading { return }
        dashboardError = nil
        sessionsError = nil
        connectorsError = nil
        isDashboardLoading = true
        defer {
            isDashboardLoading = false
            lastDashboardRefreshAt = Date()
        }

        do {
            let dashboard = try await services.dashboard.load()
            connectors = dashboard.connectors
            sessions = dashboard.sessions
            hasLoadedConnectors = true
            hasLoadedSessions = true
        } catch {
            let message = error.localizedDescription
            sessionsError = message
            connectorsError = message
        }
        dashboardError = sessionsError ?? connectorsError
    }

    /// Opens the dashboard WebSocket and continuously replaces the global Connector and Session projections.
    func startDashboardUpdates() {
        guard dashboardUpdatesTask == nil else { return }
        guard let services = makeV2Services() else { return }

        dashboardUpdatesTask = Task { [weak self] in
            guard let self else { return }
            await receiveDashboardUpdates(services: services)
        }
    }

    func renameSession(sessionId: V2SessionID, title: String) async -> Bool {
        sessionActionError = nil
        guard let services = makeV2Services() else {
            sessionActionError = String(localized: "The signed-in server is unavailable.")
            return false
        }
        do {
            let updated = try await services.dashboard.renameSession(sessionId: sessionId, title: title)
            updateSession(updated)
            return true
        } catch {
            sessionActionError = error.localizedDescription
            return false
        }
    }

    func setSessionPinned(sessionId: V2SessionID, pinned: Bool) async -> Bool {
        sessionActionError = nil
        guard let services = makeV2Services() else {
            sessionActionError = String(localized: "The signed-in server is unavailable.")
            return false
        }
        do {
            let updated = try await services.dashboard.setSessionPinned(sessionId: sessionId, pinned: pinned)
            updateSession(updated)
            return true
        } catch {
            sessionActionError = error.localizedDescription
            return false
        }
    }

    func setSessionArchived(sessionId: V2SessionID, archived: Bool) async -> Bool {
        await setSessionsArchived(sessionIds: [sessionId], archived: archived)
    }

    func setSessionsArchived(sessionIds: [V2SessionID], archived: Bool) async -> Bool {
        sessionActionError = nil
        guard let services = makeV2Services() else {
            sessionActionError = String(localized: "The signed-in server is unavailable.")
            return false
        }
        do {
            let updatedSessions = if archived {
                try await services.dashboard.archive(sessionIds: sessionIds)
            } else {
                try await services.dashboard.unarchive(sessionIds: sessionIds)
            }
            for updated in updatedSessions {
                updateSession(updated)
            }
            return true
        } catch {
            sessionActionError = error.localizedDescription
            return false
        }
    }

    func dismissSessionActionError() {
        sessionActionError = nil
    }

    /// Performs authenticated network I/O and refreshes the current account profile.
    func refreshAccount() async -> Bool {
        guard !isAccountWorking else { return false }
        accountError = nil
        guard let services = makeV2Services() else {
            accountError = String(localized: "The signed-in server is unavailable.")
            return false
        }
        isAccountWorking = true
        defer { isAccountWorking = false }
        do {
            me = try await services.account.profile()
            return true
        } catch {
            accountError = error.localizedDescription
            return false
        }
    }

    /// Performs authenticated network I/O and replaces the stored account avatar.
    func updateAccountAvatar(dataURL: String) async -> Bool {
        guard !isAccountWorking else { return false }
        accountError = nil
        guard let services = makeV2Services() else {
            accountError = String(localized: "The signed-in server is unavailable.")
            return false
        }
        isAccountWorking = true
        defer { isAccountWorking = false }
        do {
            me = try await services.account.updateAvatar(dataURL: dataURL)
            return true
        } catch {
            accountError = error.localizedDescription
            return false
        }
    }

    /// Performs authenticated network I/O and removes the stored account avatar.
    func clearAccountAvatar() async -> Bool {
        guard !isAccountWorking else { return false }
        accountError = nil
        guard let services = makeV2Services() else {
            accountError = String(localized: "The signed-in server is unavailable.")
            return false
        }
        isAccountWorking = true
        defer { isAccountWorking = false }
        do {
            me = try await services.account.clearAvatar()
            return true
        } catch {
            accountError = error.localizedDescription
            return false
        }
    }

    /// Performs authenticated network I/O and changes the current account password.
    func changeAccountPassword(newPassword: String, confirmation: String) async -> Bool {
        guard !isAccountWorking else { return false }
        accountError = nil
        guard let services = makeV2Services() else {
            accountError = String(localized: "The signed-in server is unavailable.")
            return false
        }
        isAccountWorking = true
        defer { isAccountWorking = false }
        do {
            try await services.account.changePassword(
                newPassword: newPassword,
                confirmation: confirmation
            )
            return true
        } catch {
            accountError = error.localizedDescription
            return false
        }
    }

    func dismissAccountError() {
        accountError = nil
    }

    /// Creates durable connector credentials for a new device pairing attempt.
    func createDevicePairing(name: String) async throws -> V2ConnectorCreateResponse {
        guard let services = makeV2Services() else {
            throw V2BusinessError.signedInServerUnavailable
        }
        let response = try await services.devicePairing.createDevice(name: name)
        updateConnector(response.connector)
        return response
    }

    /// Claims a one-time code and updates the in-memory dashboard projection.
    func claimDevicePairing(
        code: String,
        name: String,
        connectorId: V2ConnectorID,
        connectorToken: String
    ) async throws -> V2Connector {
        guard let services = makeV2Services(), let serverURL else {
            throw V2BusinessError.signedInServerUnavailable
        }
        let connector = try await services.devicePairing.claimPairing(
            code: code,
            name: name,
            serverURL: serverURL,
            connectorId: connectorId,
            connectorToken: connectorToken
        )
        updateConnector(connector)
        return connector
    }

    /// Reads effective connector presence while a pairing flow waits for the device.
    func devicePairingConnector(connectorId: V2ConnectorID) async throws -> V2Connector {
        guard let services = makeV2Services() else {
            throw V2BusinessError.signedInServerUnavailable
        }
        let connector = try await services.devicePairing.connector(connectorId: connectorId)
        updateConnector(connector)
        return connector
    }

    /// Requests fresh Agent discovery from an online paired device.
    func discoverDevicePairingRuntimes(connectorId: V2ConnectorID) async throws -> [V2DeviceRuntime] {
        guard let services = makeV2Services() else {
            throw V2BusinessError.signedInServerUnavailable
        }
        return try await services.devicePairing.discoverRuntimes(connectorId: connectorId)
    }

    var deviceManagementService: V2DeviceManagementService? {
        makeV2Services()?.deviceManagement
    }

    var workspaceFilesService: V2WorkspaceFilesService? {
        makeV2Services()?.workspaceFiles
    }

    func updateSession(_ updated: V2SessionMeta) {
        if let index = sessions.firstIndex(where: { $0.id == updated.id }) {
            sessions[index] = updated
        } else {
            sessions.insert(updated, at: 0)
        }
    }

    func updateConnector(_ updated: V2Connector) {
        if let index = connectors.firstIndex(where: { $0.id == updated.id }) {
            connectors[index] = updated
        } else {
            connectors.insert(updated, at: 0)
        }
    }

    func removeConnector(connectorId: V2ConnectorID) {
        connectors.removeAll { $0.id == connectorId }
        sessions.removeAll { $0.connectorId == connectorId }
    }

    func updateSessions(_ updated: [V2SessionMeta]) {
        for session in updated {
            updateSession(session)
        }
    }

    func signOut(showSignedOutRoute: Bool = true) {
        do {
            try signOutAndDeleteCredentials(showSignedOutRoute: showSignedOutRoute)
        } catch {
            authError = error.localizedDescription
        }
    }

    /// Deletes the persisted access token before clearing all authenticated in-memory state.
    func signOutAndDeleteCredentials(showSignedOutRoute: Bool = true) throws {
        dashboardUpdatesTask?.cancel()
        dashboardUpdatesTask = nil
        try keychain.delete(account: tokenAccount)
        me = nil
        serverURL = nil
        connectors = []
        sessions = []
        isDashboardLoading = false
        hasLoadedConnectors = false
        hasLoadedSessions = false
        lastDashboardRefreshAt = nil
        dashboardError = nil
        sessionsError = nil
        connectorsError = nil
        sessionActionError = nil
        isAccountWorking = false
        accountError = nil
        authError = nil
        serverConnectionIssue = nil
        if showSignedOutRoute {
            route = .signedOut
        }
    }

    func showSignedOutRoute() {
        route = .signedOut
    }

    func showSignedInRoute() async {
        route = .signedIn
        await refreshDashboard()
        startDashboardUpdates()
    }

    func activateSignedInRoute() {
        serverConnectionIssue = nil
        route = .signedIn
        Task {
            await refreshDashboard()
            startDashboardUpdates()
        }
    }

    /// Performs authenticated network I/O and refreshes the initial signed-in state.
    private func restoreAuthenticatedSession(serverURL: URL, token: String) async throws {
        let client = APIClient(serverURL: serverURL)
        me = try await client.me(token: token)
        serverConnectionIssue = nil
        route = .signedIn
        await refreshDashboard()
        startDashboardUpdates()
    }

    /// Receives server-pushed dashboard snapshots and reconnects after transient failures.
    private func receiveDashboardUpdates(services: V2ClientServices) async {
        while !Task.isCancelled {
            do {
                let updates = try await services.dashboard.updates(clientId: dashboardClientId)
                for try await snapshot in updates {
                    if Task.isCancelled { return }
                    applyDashboardSnapshot(snapshot)
                }
            } catch {
                if Task.isCancelled { return }
            }

            do {
                try await Task.sleep(for: .seconds(2))
            } catch {
                return
            }
        }
    }

    private func applyDashboardSnapshot(_ snapshot: V2DashboardSnapshot) {
        guard snapshot.type == "dashboard.snapshot" else { return }
        if connectors != snapshot.connectors {
            connectors = snapshot.connectors
        }
        if sessions != snapshot.sessions {
            sessions = snapshot.sessions
        }
        hasLoadedConnectors = true
        hasLoadedSessions = true
        connectorsError = nil
        sessionsError = nil
        dashboardError = nil
    }

    private func handleSessionRestoreFailure(_ error: Error) {
        if isAuthenticationFailure(error) {
            signOut()
            authError = error.localizedDescription
            return
        }

        route = .loading
        serverConnectionIssue = .unavailable
    }

    private func isAuthenticationFailure(_ error: Error) -> Bool {
        guard case let APIClientError.server(status, _) = error else { return false }
        return status == 401 || status == 403
    }

    private func makeV2Services() -> V2ClientServices? {
        guard
            let serverURL,
            let token = try? keychain.readString(account: tokenAccount),
            !token.isEmpty
        else {
            return nil
        }
        let api = V2APIClient(
            serverURL: serverURL,
            tokenProvider: StaticAuthTokenProvider(token: token)
        )
        return V2ClientServices(api: api)
    }

    private func saveSession(serverURL: URL, token: String) throws {
        UserDefaults.standard.set(serverURL.absoluteString, forKey: serverDefaultsKey)
        try keychain.saveString(token, account: tokenAccount)
    }

    private func currentDeviceName() -> String {
        #if os(iOS)
        UIDevice.current.name
        #else
        Host.current().localizedName ?? "Agents Anywhere iOS"
        #endif
    }
}
