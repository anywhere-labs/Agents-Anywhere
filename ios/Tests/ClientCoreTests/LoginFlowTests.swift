import Foundation
import Testing
@testable import ClientCore

@Suite struct LoginFlowTests {
    @Test func callbacksValidateTheEntireRedirectAndUniqueState() throws {
        let good = URL(string: "agents-anywhere://oauth/callback?code=valid&state=nonce")!
        #expect(try OAuthCallback.authorizationCode(good, expectedState: "nonce") == "valid")
        for invalid in [
            "agents-anywhere://other/callback?code=valid&state=nonce",
            "agents-anywhere://oauth/other?code=valid&state=nonce",
            "agents-anywhere://oauth/callback?code=valid&state=wrong",
            "agents-anywhere://oauth/callback?code=valid&state=nonce&state=nonce",
            "agents-anywhere://oauth/callback?state=nonce",
            "agents-anywhere://oauth/callback?code=valid&error=failed&state=nonce",
            "https://oauth/callback?code=valid&state=nonce"
        ] {
            #expect(throws: OAuthLoginError.invalidCallback) { try OAuthCallback.authorizationCode(URL(string: invalid)!, expectedState: "nonce") }
        }
    }
    @Test func cancellationAndProviderFailuresAreNotServerAvailabilityErrors() {
        #expect(throws: OAuthLoginError.cancelled) {
            try OAuthCallback.authorizationCode(URL(string: "agents-anywhere://oauth/callback?error=access_denied&state=nonce")!, expectedState: "nonce")
        }
        #expect(throws: OAuthLoginError.providerError("expired")) {
            try OAuthCallback.authorizationCode(URL(string: "agents-anywhere://oauth/callback?error=failed&error_description=expired&state=nonce")!, expectedState: "nonce")
        }
    }
    @Test func onlyLocalServerTargetsGetTheNativePermissionPreflight() {
        for value in ["http://192.168.0.10:8000", "http://10.0.0.2", "https://host.local", "http://office", "http://[fd12::1]:8000", "http://172.31.1.2"] {
            #expect(ServerNetworkPolicy.needsLocalAccess(URL(string: value)!))
        }
        for value in ["https://agents.example.com", "http://localhost:8000", "http://127.0.0.1", "http://[::1]", "https://172.32.0.1", "https://8.8.8.8"] {
            #expect(!ServerNetworkPolicy.needsLocalAccess(URL(string: value)!))
        }
    }
    @Test func callbackGateHandlesCancellationBeforeInstallationAndDuplicateCompletion() async throws {
        let cancelled = AsyncResultGate<String>()
        cancelled.resolve(.failure(CancellationError()))
        do {
            _ = try await withCheckedThrowingContinuation { cancelled.install($0) }
            Issue.record("Expected cancellation")
        } catch { #expect(error is CancellationError) }
        let completed = AsyncResultGate<String>()
        completed.resolve(.success("first")); completed.resolve(.success("second"))
        let value = try await withCheckedThrowingContinuation { completed.install($0) }
        #expect(value == "first")
    }
}
