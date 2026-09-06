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

    @Published private(set) var route: Route = .loading
    @Published private(set) var serverURL: URL?
    @Published private(set) var me: AuthMe? {
        didSet {
            accountAvatarSource = AccountAvatarImageSource.parse(me?.avatar)
            if let me, let serverURL, let token = accessToken() { restoration.save(profile: me, server: serverURL, token: token) }
        }
    }
    @Published var chatSelection = ChatShellSelection.newSession {
        didSet { if let scope = cachedServices?.scope, scope.accountID == me?.userId { restoration.save(selection: chatSelection, in: scope) } }
    }
    @Published private(set) var restoreConnectionError: String?
    @Published private(set) var accountAvatarSource: AccountAvatarImageSource?
    @Published private(set) var connectors: [V2Connector] = []
    @Published private(set) var sessions: [V2SessionMeta] = []
    @Published private(set) var projects: [V2Project] = []
    @Published private(set) var isDashboardLoading = false
    @Published private(set) var hasLoadedConnectors = false
    @Published private(set) var hasLoadedSessions = false
    @Published var authError: String?
    @Published private(set) var authNeedsLocalNetworkSettings = false
    @Published var dashboardError: String?
    @Published var sessionsError: String?
    @Published var connectorsError: String?
    @Published var isWorking = false
    @Published private(set) var isRetryingServerConnection = false
    @Published private(set) var sessionActionError: String?
    @Published private(set) var isAccountWorking = false
    @Published private(set) var accountError: String?

    private let keychain = KeychainStore()
    private let restoration = V2RestorationStore()
    private var accountSyncTask: Task<Void, Never>?
    private var accountSyncID = UUID()
    private var authenticationEpoch = UUID()
    private let serverDefaultsKey = "agentsAnywhere.serverURL"
    private let tokenAccount = "accessToken"
    private let dashboardClientId = "ios-dashboard-\(UUID().uuidString)"
    private var lastDashboardRefreshAt: Date?
    private var dashboardUpdatesTask: Task<Void, Never>?
    private var cachedServices: V2ClientServices?
    private var cachedServicesTokenProvider: MutableAuthTokenProvider?
    private var isInBackground = false
    private var visibleSessionID: V2SessionID?

    init() {
        Task { await restoreSession() }
    }

    var api: APIClient? {
        guard let serverURL else { return nil }
        return APIClient(serverURL: serverURL)
    }

    var isServerConnected: Bool { cachedServices?.dashboardRepository.canWrite == true }

    func accessToken() -> String? {
        try? keychain.readString(account: tokenAccount)
    }

    func restoreSession() async {
        let epoch = authenticationEpoch
        guard let serverValue = UserDefaults.standard.string(forKey: serverDefaultsKey),
              let url = URL(string: serverValue), let token = accessToken(), !token.isEmpty else {
            route = .signedOut; return
        }
        serverURL = url
        if let profile = restoration.profile(server: url, token: token) {
            me = profile
            chatSelection = restoration.selection(in: .init(serverURL: url, accountID: profile.userId))
            if let services = makeV2Services() { await services.restoreCache(selection: chatSelection) }
        }
        guard epoch == authenticationEpoch else { return }
        // Only local reads precede the first page. No HTTP response is needed to
        // display the saved navigation and durable session content.
        route = .signedIn
        startDashboardUpdates()
        beginAccountSynchronization()
    }

    func retryServerConnection() async {
        beginAccountSynchronization(force: true)
        await accountSyncTask?.value
    }

    private func beginAccountSynchronization(force: Bool = false) {
        guard !isInBackground, route == .signedIn, let serverURL, let token = accessToken(), !token.isEmpty else { return }
        if accountSyncTask != nil && !force { return }
        accountSyncTask?.cancel()
        let id = UUID(); accountSyncID = id
        let epoch = authenticationEpoch
        isRetryingServerConnection = true
        accountSyncTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if accountSyncID == id { accountSyncTask = nil; isRetryingServerConnection = false }
            }
            var attempt = 0
            while !Task.isCancelled, authenticationEpoch == epoch, !isInBackground {
                do {
                    let profile = try await APIClient(serverURL: serverURL).me(token: token)
                    guard !Task.isCancelled, authenticationEpoch == epoch, accountSyncID == id else { return }
                    let accountChanged = me?.userId != profile.userId
                    if accountChanged {
                        chatSelection = restoration.selection(in: .init(serverURL: serverURL, accountID: profile.userId))
                    }
                    me = profile
                    if accountChanged, let services = makeV2Services() { await services.restoreCache(selection: chatSelection) }
                    guard !Task.isCancelled, authenticationEpoch == epoch else { return }
                    restoreConnectionError = nil
                    startDashboardUpdates()
                    await refreshDashboard()
                    return
                } catch {
                    guard !Task.isCancelled, authenticationEpoch == epoch, accountSyncID == id else { return }
                    if isAuthenticationFailure(error) {
                        signOut(); authError = error.localizedDescription; return
                    }
                    restoreConnectionError = error.localizedDescription
                    // A transport failure retains the profile, route and cache.
                    // Backoff performs reads only; pending sends are never replayed.
                    do { try await Task.sleep(for: .seconds(min(5 * (1 << min(attempt, 3)), 30))) } catch { return }
                    attempt += 1
                }
            }
        }
    }

    func returnToLogin() {
        signOut()
    }

    func checkServer(_ value: String) async -> URL? {
        authError = nil; authNeedsLocalNetworkSettings = false
        isWorking = true
        defer { isWorking = false }
        do {
            let url = try URL.agentsServer(from: value)
            try await LocalNetworkAccess.prepare(for: url)
            try Task.checkCancellation()
            let client = APIClient(serverURL: url)
            _ = try await client.health()
            _ = try await client.authConfig()
            try Task.checkCancellation()
            return url
        } catch {
            if Task.isCancelled { return nil }
            authNeedsLocalNetworkSettings = error is LocalNetworkAccessError
            authError = error.localizedDescription
            return nil
        }
    }

    func login(serverURL: URL, email: String, password: String) async {
        authError = nil
        isWorking = true
        defer { isWorking = false }
        do {
            let client = APIClient(serverURL: serverURL)
            let auth = try await client.login(email: email, password: password)
            let profile = try await client.me(token: auth.accessToken)
            try Task.checkCancellation()
            try saveSession(serverURL: serverURL, token: auth.accessToken)
            self.serverURL = serverURL
            me = profile
            route = .signedIn
            await refreshDashboard()
            startDashboardUpdates()
        } catch {
            authError = error.localizedDescription
        }
    }

    func verifyPasswordLogin(serverURL: URL, email: String, password: String) async -> AuthResponse? {
        authError = nil
        isWorking = true
        defer { isWorking = false }
        do {
            let client = APIClient(serverURL: serverURL)
            return try await client.login(email: email, password: password)
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
            let profile = try await client.me(token: auth.accessToken)
            try Task.checkCancellation()
            try saveSession(serverURL: serverURL, token: auth.accessToken)
            self.serverURL = serverURL
            me = profile
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
            let profile = try await client.me(token: token.accessToken)
            try Task.checkCancellation()
            try saveSession(serverURL: serverURL, token: token.accessToken)
            self.serverURL = serverURL
            me = profile
            if showSignedInRoute {
                route = .signedIn
                await refreshDashboard()
                startDashboardUpdates()
            }
        } catch {
            if !Task.isCancelled { authError = error.localizedDescription }
        }
    }

    func requestMobileLogin(payload: MobileLoginPayload) async -> Bool {
        authError = nil; authNeedsLocalNetworkSettings = false
        isWorking = true
        defer { isWorking = false }
        do {
            let serverURL = try URL.agentsServer(from: payload.webUrl)
            try await LocalNetworkAccess.prepare(for: serverURL)
            try Task.checkCancellation()
            let client = APIClient(serverURL: serverURL)
            _ = try await client.requestMobileLogin(
                payload: payload,
                deviceName: currentDeviceName(),
            )
            try Task.checkCancellation()
            self.serverURL = serverURL
            return true
        } catch {
            if Task.isCancelled { return false }
            authNeedsLocalNetworkSettings = error is LocalNetworkAccessError
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
            let profile = try await client.me(token: exchange.auth.accessToken)
            try Task.checkCancellation()
            try saveSession(serverURL: serverURL, token: exchange.auth.accessToken)
            self.serverURL = serverURL
            me = profile
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
        await services.dashboardRepository.refresh()
        if cachedServices === services { lastDashboardRefreshAt = Date() }
    }

    private func syncDashboard(_ services: V2ClientServices) {
        guard cachedServices === services else { return }
        let repository = services.dashboardRepository
        if connectors != repository.connectors { connectors = repository.connectors }
        if projects != repository.projects { projects = repository.projects }
        if sessions != repository.sessions { sessions = repository.sessions }
        isDashboardLoading = repository.isLoading
        hasLoadedConnectors = repository.hasLoaded
        hasLoadedSessions = repository.hasLoaded
        dashboardError = repository.error
        connectorsError = repository.error
        sessionsError = repository.error
        services.sessionReads.setActive(!isInBackground)
        services.sessionReads.updateConnectivity(repository.isFresh ? services.connectivity.status : .init(availability: .offline))
        services.sessionRepository.applyMetadata(sessions)
        services.updateAgentConnections()
        if repository.hasLoaded { services.newSession.updateProjects(projects) }
    }

    /// Opens the dashboard WebSocket and continuously replaces the global Connector and Session projections.
    func startDashboardUpdates() {
        guard dashboardUpdatesTask == nil, !isInBackground, route == .signedIn else { return }
        guard let services = makeV2Services() else { return }
        guard services.connectivity.status.availability != .offline else { return }

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
            guard cachedServices === services else { return false }
            updateSession(updated)
            return true
        } catch {
            sessionActionError = error.localizedDescription
            return false
        }
    }

    func setVisibleSession(_ sessionId: V2SessionID?) {
        guard route == .signedIn else { return }
        visibleSessionID = sessionId
        makeV2Services()?.sessionReads.setVisibleSession(sessionId?.hasPrefix("local:") == true ? nil : sessionId)
    }

    func setSessionPinned(sessionId: V2SessionID, pinned: Bool) async -> Bool {
        sessionActionError = nil
        guard let services = makeV2Services() else {
            sessionActionError = String(localized: "The signed-in server is unavailable.")
            return false
        }
        do {
            let updated = try await services.dashboard.setSessionPinned(sessionId: sessionId, pinned: pinned)
            guard cachedServices === services else { return false }
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
            guard cachedServices === services else { return false }
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
            let profile = try await services.account.profile()
            guard cachedServices === services else { return false }
            me = profile
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
            let profile = try await services.account.updateAvatar(dataURL: dataURL)
            guard cachedServices === services else { return false }
            me = profile
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
            let profile = try await services.account.clearAvatar()
            guard cachedServices === services else { return false }
            me = profile
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

    func accountAuthConfig() async throws -> AuthConfig {
        guard let services = makeV2Services() else {
            throw APIClientError.invalidServerURL
        }
        return try await services.account.authConfig()
    }

    func updateAccountProfile(displayName: String) async throws {
        guard let services = makeV2Services() else {
            throw APIClientError.invalidServerURL
        }
        let profile = try await services.account.updateProfile(displayName: displayName)
        guard cachedServices === services else { throw CancellationError() }
        me = profile
    }

    func sendAccountEmailCode(email: String) async throws -> V2EmailCodeResponse {
        guard let services = makeV2Services() else {
            throw APIClientError.invalidServerURL
        }
        return try await services.account.sendEmailCode(email: email)
    }

    func bindAccountEmail(email: String, code: String?) async throws {
        guard let services = makeV2Services() else {
            throw APIClientError.invalidServerURL
        }
        let profile = try await services.account.bindEmail(email: email, code: code)
        guard cachedServices === services else { throw CancellationError() }
        me = profile
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
        guard cachedServices === services else { throw CancellationError() }
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
        guard cachedServices === services else { throw CancellationError() }
        updateConnector(connector)
        return connector
    }

    /// Reads effective connector presence while a pairing flow waits for the device.
    func devicePairingConnector(connectorId: V2ConnectorID) async throws -> V2Connector {
        guard let services = makeV2Services() else {
            throw V2BusinessError.signedInServerUnavailable
        }
        let connector = try await services.devicePairing.connector(connectorId: connectorId)
        guard cachedServices === services else { throw CancellationError() }
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

    func devicePairingRuntimeConfigSchema(runtime: V2DeviceRuntime) throws -> V2RuntimeConfigSchema {
        guard let services = makeV2Services() else {
            throw V2BusinessError.signedInServerUnavailable
        }
        return try services.deviceManagement.configSchema(runtime: runtime)
    }

    /// Performs authenticated network I/O to save configuration and start a paired runtime.
    func configureAndStartDevicePairingRuntime(
        connectorId: V2ConnectorID,
        runtimeId: V2RuntimeID,
        config: [String: JSONValue]
    ) async throws -> V2DeviceRuntime {
        guard let services = makeV2Services() else {
            throw V2BusinessError.signedInServerUnavailable
        }
        return try await services.deviceManagement.configureAndStartRuntime(
            connectorId: connectorId,
            runtimeId: runtimeId,
            config: config
        )
    }

    var deviceManagementService: V2DeviceManagementService? {
        makeV2Services()?.deviceManagement
    }

    var workspaceFilesService: V2WorkspaceFilesService? {
        makeV2Services()?.workspaceFiles
    }

    func updateSession(_ updated: V2SessionMeta) {
        cachedServices?.dashboardRepository.upsert([updated])
    }

    func updateConnector(_ updated: V2Connector) {
        cachedServices?.dashboardRepository.upsertConnector(updated)
    }

    func removeConnector(connectorId: V2ConnectorID) {
        cachedServices?.sessionRepository.remove(sessionIds: sessions.filter { $0.connectorId == connectorId }.map(\.id))
        cachedServices?.dashboardRepository.removeConnector(connectorId)
    }

    func updateSessions(_ updated: [V2SessionMeta]) {
        cachedServices?.dashboardRepository.upsert(updated)
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
        authenticationEpoch = UUID(); accountSyncID = UUID()
        accountSyncTask?.cancel(); accountSyncTask = nil; isRetryingServerConnection = false
        restoration.clear(scope: cachedServices?.scope)
        cachedServices?.shutdown(removingCache: true)
        cachedServices = nil
        cachedServicesTokenProvider?.update(nil)
        cachedServicesTokenProvider = nil
        chatSelection = .newSession; restoreConnectionError = nil
        visibleSessionID = nil
        me = nil
        serverURL = nil
        connectors = []
        sessions = []
        projects = []
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
        route = .signedIn
        Task {
            await refreshDashboard()
            startDashboardUpdates()
        }
    }

    /// Receives server-pushed dashboard snapshots and reconnects after transient failures.
    private func receiveDashboardUpdates(services: V2ClientServices) async {
        var attempt = 0
        while !Task.isCancelled {
            do {
                let updates = try await services.dashboard.updates(clientId: dashboardClientId)
                for try await snapshot in updates {
                    if Task.isCancelled || cachedServices !== services { return }
                    attempt = 0
                    applyDashboardSnapshot(snapshot)
                }
            } catch {
                if Task.isCancelled { return }
                let failure = V2ClientFailure(error)
                guard cachedServices === services else { return }
                dashboardError = failure.message
                if !failure.permitsAutomaticReconnect { return }
            }

            do {
                try await Task.sleep(for: .seconds(min(1 << min(attempt, 4), 15)))
                attempt += 1
            } catch {
                return
            }
        }
    }

    private func applyDashboardSnapshot(_ snapshot: V2DashboardSnapshot) {
        cachedServices?.dashboardRepository.apply(snapshot)
    }

    private func isAuthenticationFailure(_ error: Error) -> Bool {
        guard case let APIClientError.server(status, _) = error else { return false }
        return status == 401 || status == 403
    }

    var sessionRepository: V2SessionRepository? { makeV2Services()?.sessionRepository }
    var nativeChatServices: V2ClientServices? { makeV2Services() }

    func sessionModel(id: V2SessionID) -> V2SessionModel? { sessionRepository?.session(id: id) }

    func setAppInBackground(_ background: Bool) {
        isInBackground = background
        cachedServices?.sessionReads.setActive(!background)
        cachedServices?.agentSetup.setActive(!background)
        if background {
            accountSyncID = UUID(); accountSyncTask?.cancel(); accountSyncTask = nil; isRetryingServerConnection = false
            if let services = cachedServices { Task { await services.flushCache() } }
            dashboardUpdatesTask?.cancel()
            dashboardUpdatesTask = nil
            cachedServices?.sessionRepository.suspend()
        } else {
            cachedServices?.sessionRepository.resume()
            startDashboardUpdates()
            beginAccountSynchronization()
        }
    }

    private func makeV2Services() -> V2ClientServices? {
        guard
            let serverURL,
            let accountID = me?.userId,
            let token = try? keychain.readString(account: tokenAccount),
            !token.isEmpty
        else {
            return nil
        }
        let scope = V2ClientScope(serverURL: serverURL, accountID: accountID)
        if let cachedServices, cachedServices.scope == scope, let provider = cachedServicesTokenProvider {
            provider.update(token)
            return cachedServices
        }
        dashboardUpdatesTask?.cancel()
        dashboardUpdatesTask = nil
        isDashboardLoading = false
        cachedServicesTokenProvider?.update(nil)
        cachedServices?.shutdown()
        let tokenProvider = MutableAuthTokenProvider(token: token)
        let api = V2APIClient(
            serverURL: serverURL,
            tokenProvider: tokenProvider
        )
        let services = V2ClientServices(api: api, accountID: accountID)
        cachedServices = services
        cachedServicesTokenProvider = tokenProvider
        services.dashboardRepository.reconcile = { [weak services] in services?.sessionReads.ingest($0) ?? $0 }
        services.dashboardRepository.onChange = { [weak self, weak services] in
            guard let services else { return }
            self?.syncDashboard(services)
        }
        services.onSelectPage = { [weak self] selection in self?.chatSelection = selection }
        services.onCreationBound = { [weak self] localID, serverID in
            if self?.chatSelection == .session(localID) { self?.chatSelection = .session(serverID) }
        }
        syncDashboard(services)
        services.agentSetup.onOnline = { [weak services] connector in services?.dashboardRepository.upsertConnector(connector) }
        services.agentSetup.setActive(!isInBackground)
        services.sessionReads.setActive(!isInBackground)
        services.sessionReads.onChange = { [weak self, weak services] id in
            guard let self, let services, self.cachedServices === services,
                  let index = self.sessions.firstIndex(where: { $0.id == id }) else { return }
            let updated = services.sessionReads.project(self.sessions[index])
            if self.sessions[index] != updated {
                services.dashboardRepository.upsert([updated])
            }
        }
        services.sessionReads.setVisibleSession(visibleSessionID?.hasPrefix("local:") == true ? nil : visibleSessionID)
        if isInBackground { services.sessionRepository.suspend() }
        services.onConnectivityChange = { [weak self, weak services] status in
            guard let self, let services, self.cachedServices === services else { return }
            if status.availability == .offline {
                self.dashboardUpdatesTask?.cancel()
                self.dashboardUpdatesTask = nil
            } else {
                self.startDashboardUpdates()
                if self.restoreConnectionError != nil { self.beginAccountSynchronization(force: true) }
            }
        }
        return services
    }

    private func saveSession(serverURL: URL, token: String) throws {
        authenticationEpoch = UUID(); accountSyncID = UUID()
        accountSyncTask?.cancel(); accountSyncTask = nil; isRetryingServerConnection = false
        restoreConnectionError = nil
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
