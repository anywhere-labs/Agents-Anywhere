import Foundation

/// Model profiles, the current channel and its per-runtime switch, and the
/// Tokens Anywhere link.
/// Keys go in and never come back.
struct V2ModelConfigAPI {
    let transport: any HTTPTransport

    func createProfile(_ request: V2ModelProfileCreateRequest) async throws -> V2ModelProfile {
        try await transport.send(HTTPRequest<V2ModelProfileCreateRequest, V2ModelProfile>(
            method: .post, path: "/model-profiles", body: request))
    }

    func deleteProfile(id: String) async throws {
        _ = try await transport.send(HTTPRequest<EmptyRequestBody, EmptyResponse>(
            method: .delete, path: "/model-profiles/\(id.v2URLPathComponentEncoded)"))
    }

    // MARK: Current channel

    func channel() async throws -> V2ModelChannelState {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2ModelChannelState>(
            method: .get, path: "/model-config/channel"))
    }

    /// Sets the current channel; answers at once while runtimes switch in the background.
    func setChannel(_ channel: String) async throws -> V2ModelChannelState {
        try await transport.send(HTTPRequest<V2ChannelRequest, V2ModelChannelState>(
            method: .put, path: "/model-config/channel", body: .init(channel: channel)))
    }

    /// Chooses a channel for one runtime; nil follows the current channel again.
    func setRuntimeChannel(_ target: V2ModelTarget, channel: String?, confirmNativeGlobal: Bool) async throws -> V2ModelChannelState {
        try await transport.send(HTTPRequest<V2RuntimeChannelRequest, V2ModelChannelState>(
            method: .put, path: "/model-config/channel/runtimes/\(target.pathComponents)",
            body: .init(channel: channel, confirmNativeGlobal: confirmNativeGlobal)))
    }

    /// Retries every restored or failed runtime, or only `target`.
    func retryChannel(_ target: V2ModelTarget? = nil) async throws -> V2ModelChannelState {
        try await transport.send(HTTPRequest<V2ChannelRetryRequest, V2ModelChannelState>(
            method: .post, path: "/model-config/channel/retry", body: .init(target)))
    }

    // MARK: Tokens Anywhere

    /// A one-time address to open in a browser that authorizes the link.
    func beginTokensLink() async throws -> V2TokensLinkStart {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2TokensLinkStart>(
            method: .post, path: "/integrations/tokens/link"))
    }

    /// The linked account, its balance and its console pages.
    func tokensAccount() async throws -> V2TokensAccountInfo {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2TokensAccountInfo>(
            method: .get, path: "/integrations/tokens/account"))
    }

    /// The whole Tokens account's settled usage over the last `days` Beijing days.
    func tokensUsage(days: Int) async throws -> V2TokensUsage {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2TokensUsage>(
            method: .get, path: "/integrations/tokens/usage",
            queryItems: [URLQueryItem(name: "days", value: String(days))]))
    }

    /// Turns models off and renames them; runtimes using Tokens get the change in the background.
    func saveTokensModels(_ preferences: V2ModelPreferences) async throws -> V2TokensModelsSaveResponse {
        try await transport.send(HTTPRequest<V2ModelPreferences, V2TokensModelsSaveResponse>(
            method: .put, path: "/integrations/tokens/models", body: preferences))
    }

    func syncTokens() async throws -> V2ModelProfile {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2ModelProfile>(
            method: .post, path: "/integrations/tokens/sync"))
    }

    /// Refused with `channel_in_use` while a runtime wants or uses the Anywhere channel.
    func unlinkTokens() async throws -> V2TokensUnlinkResponse {
        try await transport.send(HTTPRequest<EmptyRequestBody, V2TokensUnlinkResponse>(
            method: .delete, path: "/integrations/tokens/link"))
    }

    /// Without `allowInterrupt`, running tasks refuse it as `busy` before anything rotates.
    /// Answers with the channel state the new key's rewrite shows up in.
    func rotateTokensKey(profileId: String, allowInterrupt: Bool) async throws -> V2ModelChannelState {
        try await transport.send(HTTPRequest<V2AllowInterruptRequest, V2ModelChannelState>(
            method: .post, path: "/model-profiles/\(profileId.v2URLPathComponentEncoded)/rotate-key",
            body: .init(allowInterrupt: allowInterrupt)))
    }
}

private extension V2ModelTarget {
    var pathComponents: String {
        "\(connectorId.v2URLPathComponentEncoded)/\(runtimeId.v2URLPathComponentEncoded)"
    }
}
