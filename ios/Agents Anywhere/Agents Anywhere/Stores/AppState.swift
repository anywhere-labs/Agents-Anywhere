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
    @Published private(set) var me: AuthMe?
    @Published private(set) var connectors: [ConnectorSummary] = []
    @Published private(set) var sessions: [SessionSummary] = []
    @Published private(set) var isDashboardLoading = false
    @Published private(set) var hasLoadedConnectors = false
    @Published private(set) var hasLoadedSessions = false
    @Published var authError: String?
    @Published var dashboardError: String?
    @Published var sessionsError: String?
    @Published var connectorsError: String?
    @Published var isWorking = false

    private let keychain = KeychainStore()
    private let serverDefaultsKey = "agentsAnywhere.serverURL"
    private let tokenAccount = "accessToken"
    private var lastDashboardRefreshAt: Date?

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
            let client = APIClient(serverURL: serverURL)
            me = try await client.me(token: token)
            route = .signedIn
            await refreshDashboard()
        } catch {
            try? keychain.delete(account: tokenAccount)
            authError = error.localizedDescription
            route = .signedOut
        }
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
        guard let api, let token = try? keychain.readString(account: tokenAccount) else { return }
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
            let sessionResponse = try await api.listSessions(token: token)
            sessions = sessionResponse.sessions
            hasLoadedSessions = true
        } catch {
            sessionsError = error.localizedDescription
        }

        do {
            let connectorResponse = try await api.listConnectors(token: token)
            connectors = connectorResponse.connectors
            hasLoadedConnectors = true
        } catch {
            connectorsError = error.localizedDescription
        }
        dashboardError = sessionsError ?? connectorsError
    }

    func updateSession(_ updated: SessionSummary) {
        if let index = sessions.firstIndex(where: { $0.id == updated.id }) {
            sessions[index] = updated
        } else {
            sessions.insert(updated, at: 0)
        }
    }

    func signOut(showSignedOutRoute: Bool = true) {
        try? keychain.delete(account: tokenAccount)
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
