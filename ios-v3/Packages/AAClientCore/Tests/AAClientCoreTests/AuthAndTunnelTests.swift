import Foundation
import Testing

@testable import AAClientCore

/// Scripted HTTP responses keyed by path.
final class FakeTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    var responses: [String: [(Int, String)]] = [:]
    private(set) var requests: [URLRequest] = []

    func queue(_ path: String, _ status: Int, _ body: String) {
        lock.withLock { responses[path, default: []].append((status, body)) }
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        let (status, body): (Int, String) = lock.withLock {
            requests.append(request)
            guard var list = responses[path], !list.isEmpty else { return (404, #"{"detail":"not scripted"}"#) }
            let first = list.removeFirst()
            responses[path] = list
            return first
        }
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }

    func count(_ path: String) -> Int { lock.withLock { requests.filter { $0.url?.path == path }.count } }
}

func tokenBody(access: String, refresh: String, expiresIn: Int = 3600) -> String {
    """
    {"user":{"id":"u1","email":"dev@aa.local","display_name":"Dev","role":"admin","created_at":"2026-11-22T00:00:00Z","plan":null,
     "entitlements":{},"active_context":null},
     "access_token":"\(access)","refresh_token":"\(refresh)","expires_in":\(expiresIn),"client_id":"cli_1"}
    """
}

@Suite("Auth session")
struct AuthTests {
    @Test func normalizesControlURLs() {
        #expect(ControlHTTPClient.normalize("127.0.0.1:8790/")?.absoluteString == "http://127.0.0.1:8790")
        #expect(ControlHTTPClient.normalize(" https://aa.example.com// ")?.absoluteString == "https://aa.example.com")
        #expect(ControlHTTPClient.normalize("ftp://x") == nil)
        #expect(ControlHTTPClient.normalize("") == nil)
    }

    @Test func signInPersistsAndRefreshesWhenExpired() async throws {
        let transport = FakeTransport()
        let store = MemorySecretStore()
        transport.queue("/auth/login", 200, tokenBody(access: "a1", refresh: "r1", expiresIn: 30))
        let session = try await AuthSession.signIn(controlURL: "127.0.0.1:8790", email: "dev@aa.local", password: "pw", store: store, transport: transport)
        let login = try #require(transport.requests.first)
        let body = try JSONSerialization.jsonObject(with: login.httpBody ?? Data()) as? [String: String]
        #expect(body?["client_platform"] == "ios")

        // 30 s left: within the refresh window, so a new token is fetched and the rotated refresh token stored.
        transport.queue("/auth/refresh", 200, tokenBody(access: "a2", refresh: "r2"))
        #expect(try await session.accessToken() == "a2")
        #expect(try await session.accessToken() == "a2")
        #expect(transport.count("/auth/refresh") == 1)
        let stored = try #require(try store.value(StoredAccount.self, for: AuthSession.storageKey))
        #expect(stored.refreshToken == "r2")
        #expect(AuthSession.restore(store: store, transport: transport) != nil)
    }

    @Test func routerTokenRetriesAfter401() async throws {
        let transport = FakeTransport()
        let store = MemorySecretStore()
        transport.queue("/auth/login", 200, tokenBody(access: "a1", refresh: "r1"))
        let session = try await AuthSession.signIn(controlURL: "http://h", email: "e", password: "p", store: store, transport: transport)
        transport.queue("/auth/router-token", 401, #"{"detail":"expired"}"#)
        transport.queue("/auth/refresh", 200, tokenBody(access: "a2", refresh: "r2"))
        transport.queue("/auth/router-token", 200, """
            {"principal":"user:u1/client:cli_1","tokens":[{"router_id":"r","router_url":"ws://127.0.0.1:7690","token":"mt_x","token_id":"t","expires_at":"2026-11-22T20:30:17.555000Z"}]}
            """)
        let issued = try await session.routerToken()
        #expect(issued.tokens.first?.token == "mt_x")
        #expect(transport.requests.last?.value(forHTTPHeaderField: "Authorization") == "Bearer a2")
    }

    @Test func refusedLoginSurfacesServerMessage() async {
        let transport = FakeTransport()
        transport.queue("/auth/login", 401, #"{"detail":"邮箱或密码不正确"}"#)
        do {
            _ = try await AuthSession.signIn(controlURL: "http://h", email: "e", password: "p", store: MemorySecretStore(), transport: transport)
            Issue.record("expected failure")
        } catch let error as ControlAPIError {
            #expect(error.isAuthRejection)
            #expect(error.message == "邮箱或密码不正确")
        } catch {
            Issue.record("unexpected \(error)")
        }
    }
}

/// Tunnel issuer that hands out canned credentials (no Router is contacted for the refusal paths).
struct FakeIssuer: TunnelIssuer {
    var credential: String

    func openTunnel(deviceID: String, e2eKey: String?) async throws -> OpenTunnelResponse {
        OpenTunnelResponse(routerURL: "ws://127.0.0.1:1", credential: credential, tunnelID: "tun_1", expiresAt: "2026-11-22T20:00:00Z", mode: "normal")
    }
}

@Suite("Tunnel pool end-to-end policy")
struct TunnelPolicyTests {
    func pool(credential: String, store: MemorySecretStore = MemorySecretStore()) -> (DeviceTunnelPool, TrustStore) {
        let trust = TrustStore(store: store, accountID: "u1")
        return (DeviceTunnelPool(issuer: FakeIssuer(credential: credential), trust: trust, identity: ClientIdentityStore(store: store)), trust)
    }

    func code(_ run: () async throws -> Void) async -> PairingErrorCode? {
        do {
            try await run()
            return nil
        } catch let error as PairingError {
            return error.code
        } catch {
            return nil
        }
    }

    @Test func encryptedHintWithoutPairingIsRefused() async {
        let (pool, _) = pool(credential: "mtun_plain")
        await pool.updateDevices([DeviceRecord(id: "dev_1", name: "Mac", modeHint: "encrypted")])
        #expect(await pool.requiresE2EE("dev_1"))
        #expect(await code { _ = try await pool.status("dev_1") } == .e2eNotPaired)
    }

    @Test func pinnedDeviceRefusesPlaintextCredential() async throws {
        let (pool, trust) = pool(credential: "mtun_plain")
        var record = DeviceTrustRecord(payload: try PairingPayload.parse(PairingTests.payload()))
        record.confirmed = true
        try trust.save(record)
        // The server now claims the device is normal: the local pin wins.
        await pool.updateDevices([DeviceRecord(id: "dev_1", name: "Mac", modeHint: "normal")])
        #expect(await code { _ = try await pool.status("dev_1") } == .e2eRequiredLocally)
    }

    @Test func unpinnedDeviceRefusesEndToEndCredential() async {
        let (pool, _) = pool(credential: "mtun_e2e.abc")
        #expect(await code { _ = try await pool.status("dev_1") } == .e2eNotPaired)
    }

    @Test func failedPairingRollsBackTrust() async throws {
        let (pool, trust) = pool(credential: "mtun_plain")
        #expect(await code { _ = try await pool.pair(uri: PairingTests.payload()) } == .e2eRequiredLocally)
        #expect(trust.record(for: "dev_1") == nil)
    }

    @Test func pairingWithADifferentKeyIsRefused() async throws {
        let (pool, trust) = pool(credential: "mtun_e2e.abc")
        var record = DeviceTrustRecord(payload: try PairingPayload.parse(PairingTests.payload()))
        record.confirmed = true
        try trust.save(record)
        #expect(await code { _ = try await pool.pair(uri: PairingTests.payload()) } == .devicePubMismatch)
        #expect(trust.record(for: "dev_1")?.devicePub == record.devicePub)
    }
}
