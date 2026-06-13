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
    @Published var authError: String?
    @Published var dashboardError: String?
    @Published var isWorking = false

    private let keychain = KeychainStore()
    private let serverDefaultsKey = "agentsAnywhere.serverURL"
    private let tokenAccount = "accessToken"

    init() {
        Task { await restoreSession() }
    }

    var api: APIClient? {
        guard let serverURL else { return nil }
        return APIClient(serverURL: serverURL)
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

    func exchangeMobileLogin(payload: MobileLoginPayload) async {
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
            route = .signedIn
            await refreshDashboard()
        } catch {
            authError = error.localizedDescription
        }
    }

    func refreshDashboard() async {
        guard let api, let token = try? keychain.readString(account: tokenAccount) else { return }
        dashboardError = nil
        do {
            async let connectorResult = api.listConnectors(token: token)
            async let sessionResult = api.listSessions(token: token)
            let connectorResponse = try await connectorResult
            let sessionResponse = try await sessionResult
            connectors = connectorResponse.connectors
            sessions = sessionResponse.sessions
        } catch {
            dashboardError = error.localizedDescription
        }
    }

    func signOut() {
        try? keychain.delete(account: tokenAccount)
        me = nil
        connectors = []
        sessions = []
        route = .signedOut
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
