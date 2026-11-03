import Foundation

// Model connections and model configuration. Enum-like wire values stay strings
// so a value a newer Server adds never breaks decoding; presentation maps the
// ones it knows. Keys go to the Server and never come back.

nonisolated enum V2RuntimeMaturity: String, Hashable, Sendable {
    case experimental
    case beta
    case stable
}

nonisolated enum V2ModelProtocol: String, CaseIterable, Hashable, Sendable {
    case openaiResponses = "openai_responses"
    case openaiChat = "openai_chat"
    case anthropic
}

nonisolated struct V2ModelConnectionMode: Decodable, Hashable {
    let id: String
    let supported: Bool
    let reason: String?
}

nonisolated struct V2ModelConnectionCatalog: Decodable, Hashable {
    let auto: Bool
    let manual: Bool
}

/// How a runtime takes a model connection, declared by its adapter.
nonisolated struct V2ModelConnectionCapability: Decodable, Hashable {
    let maturity: String?
    let configField: String
    let modelsField: String?
    let protocols: [String]
    let modes: [V2ModelConnectionMode]
    let modeField: String?
    /// "instance", "session" or "native_global".
    let scope: String?
    let catalog: V2ModelConnectionCatalog?
    /// "immediate", "new_session" or "restart".
    let apply: String?

    private enum CodingKeys: String, CodingKey {
        case maturity, configField, modelsField, protocols, modes, modeField, scope, catalog, apply
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        configField = try container.decode(String.self, forKey: .configField)
        maturity = try? container.decodeIfPresent(String.self, forKey: .maturity)
        modelsField = try? container.decodeIfPresent(String.self, forKey: .modelsField)
        protocols = (try? container.decodeIfPresent([String].self, forKey: .protocols)) ?? []
        modes = (try? container.decodeIfPresent([V2ModelConnectionMode].self, forKey: .modes)) ?? []
        modeField = try? container.decodeIfPresent(String.self, forKey: .modeField)
        scope = try? container.decodeIfPresent(String.self, forKey: .scope)
        catalog = try? container.decodeIfPresent(V2ModelConnectionCatalog.self, forKey: .catalog)
        apply = try? container.decodeIfPresent(String.self, forKey: .apply)
    }
}

/// The connection state a client shows. "applied" means the runtime took the
/// configuration; it is not a probe of the endpoint.
nonisolated struct V2ModelConnectionStatus: Decodable, Hashable {
    /// not_configured, saved_pending, applied, failed or managed_externally.
    let state: String
    let connectionProtocol: String?
    let scope: String?
    let mode: String?
    let reason: String?
    let externalOwner: String?

    private enum CodingKeys: String, CodingKey {
        case state, connectionProtocol = "protocol", scope, mode, reason, externalOwner
    }

    init(state: String, connectionProtocol: String? = nil, scope: String? = nil, mode: String? = nil,
         reason: String? = nil, externalOwner: String? = nil) {
        self.state = state; self.connectionProtocol = connectionProtocol; self.scope = scope
        self.mode = mode; self.reason = reason; self.externalOwner = externalOwner
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try container.decode(String.self, forKey: .state)
        connectionProtocol = try? container.decodeIfPresent(String.self, forKey: .connectionProtocol)
        scope = try? container.decodeIfPresent(String.self, forKey: .scope)
        mode = try? container.decodeIfPresent(String.self, forKey: .mode)
        reason = try? container.decodeIfPresent(String.self, forKey: .reason)
        externalOwner = try? container.decodeIfPresent(String.self, forKey: .externalOwner)
    }
}

/// What the Server says about a write-only value it keeps: never the value.
nonisolated struct V2RuntimeSecretField: Decodable, Hashable {
    let isSet: Bool
    let hint: String?

    private enum CodingKeys: String, CodingKey { case isSet = "set", hint }

    init(isSet: Bool, hint: String?) { self.isSet = isSet; self.hint = hint }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        isSet = (try? container.decodeIfPresent(Bool.self, forKey: .isSet)) ?? false
        hint = try? container.decodeIfPresent(String.self, forKey: .hint)
    }
}

nonisolated struct V2ModelSpec: Codable, Hashable {
    let id: String
    var name: String?
    var efforts: [String]?
    var input: [String]?
    /// Who makes the model, as Tokens Anywhere names it.
    var vendor: String?
    var contextWindow: Int?
    var maxOutputTokens: Int?
}

extension V2ModelSpec {
    private enum CodingKeys: String, CodingKey { case id, name, efforts, input, vendor, contextWindow, maxOutputTokens }

    /// Only the ID is required; an odd optional field reads as absent.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try? container.decodeIfPresent(String.self, forKey: .name)
        efforts = try? container.decodeIfPresent([String].self, forKey: .efforts)
        input = try? container.decodeIfPresent([String].self, forKey: .input)
        vendor = try? container.decodeIfPresent(String.self, forKey: .vendor)
        contextWindow = try? container.decodeIfPresent(Int.self, forKey: .contextWindow)
        maxOutputTokens = try? container.decodeIfPresent(Int.self, forKey: .maxOutputTokens)
    }
}

/// Models turned off, and names shown in place of the model's own. They apply
/// to every runtime using Tokens Anywhere and to Agents Anywhere only.
nonisolated struct V2ModelPreferences: Codable, Hashable {
    var disabled: [String]
    var names: [String: String]

    static let empty = V2ModelPreferences(disabled: [], names: [:])

    init(disabled: [String] = [], names: [String: String] = [:]) {
        self.disabled = disabled; self.names = names
    }

    private enum CodingKeys: String, CodingKey { case disabled, names }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        disabled = (try? container.decodeIfPresent([String].self, forKey: .disabled)) ?? []
        names = (try? container.decodeIfPresent([String: String].self, forKey: .names)) ?? [:]
    }
}

nonisolated struct V2ModelOffer: Codable, Hashable {
    let format: String
    let baseUrl: String
    let models: [V2ModelSpec]

    init(format: String, baseUrl: String, models: [V2ModelSpec]) {
        self.format = format; self.baseUrl = baseUrl; self.models = models
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        format = try container.decode(String.self, forKey: .format)
        baseUrl = try container.decode(String.self, forKey: .baseUrl)
        models = (try? container.decodeIfPresent([V2ModelSpec].self, forKey: .models)) ?? []
    }
}

nonisolated struct V2ModelProfile: Decodable, Hashable, Identifiable {
    let id: String
    /// "tokens" or "manual".
    let source: String
    let name: String
    let originHost: String
    let offers: [V2ModelOffer]
    let keyHint: String?
    let strategyName: String?
    /// "active" or "detached".
    let state: String
    let etag: String?
    let updatedAt: String?
    /// Models turned off and renamed; only the Tokens profile carries them.
    let preferences: V2ModelPreferences

    private enum CodingKeys: String, CodingKey {
        case id, source, name, originHost, offers, keyHint, strategyName, state, etag, updatedAt, preferences
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        source = (try? container.decodeIfPresent(String.self, forKey: .source)) ?? "manual"
        name = (try? container.decodeIfPresent(String.self, forKey: .name)) ?? id
        originHost = (try? container.decodeIfPresent(String.self, forKey: .originHost)) ?? ""
        offers = (try? container.decodeIfPresent([V2ModelOffer].self, forKey: .offers)) ?? []
        keyHint = try? container.decodeIfPresent(String.self, forKey: .keyHint)
        strategyName = try? container.decodeIfPresent(String.self, forKey: .strategyName)
        state = (try? container.decodeIfPresent(String.self, forKey: .state)) ?? "active"
        etag = try? container.decodeIfPresent(String.self, forKey: .etag)
        updatedAt = try? container.decodeIfPresent(String.self, forKey: .updatedAt)
        preferences = (try? container.decodeIfPresent(V2ModelPreferences.self, forKey: .preferences)) ?? .empty
    }

    var isActive: Bool { state == "active" }
    var isTokens: Bool { source == "tokens" }
    var modelCount: Int { Set(offers.flatMap { $0.models.map(\.id) }).count }
}

nonisolated struct V2ModelTarget: Codable, Hashable {
    let connectorId: V2ConnectorID
    let runtimeId: V2RuntimeID

    var key: String { "\(connectorId)/\(runtimeId)" }
}

nonisolated struct V2ModelAssignment: Decodable, Hashable, Identifiable {
    let connectorId: V2ConnectorID
    let runtimeId: V2RuntimeID
    let profileId: String
    let offerFormat: String?
    let createdRuntime: Bool
    /// applied, modified or outdated. Switch progress lives in the channel state.
    let status: String
    let error: JSONValue?
    let appliedAt: String?
    let modelConnectionStatus: V2ModelConnectionStatus?

    private enum CodingKeys: String, CodingKey {
        case connectorId, runtimeId, profileId, offerFormat, createdRuntime, status, error, appliedAt, modelConnectionStatus
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        connectorId = try container.decode(String.self, forKey: .connectorId)
        runtimeId = try container.decode(String.self, forKey: .runtimeId)
        profileId = try container.decode(String.self, forKey: .profileId)
        offerFormat = try? container.decodeIfPresent(String.self, forKey: .offerFormat)
        createdRuntime = (try? container.decodeIfPresent(Bool.self, forKey: .createdRuntime)) ?? false
        status = (try? container.decodeIfPresent(String.self, forKey: .status)) ?? "applied"
        error = try? container.decodeIfPresent(JSONValue.self, forKey: .error)
        appliedAt = try? container.decodeIfPresent(String.self, forKey: .appliedAt)
        modelConnectionStatus = try? container.decodeIfPresent(V2ModelConnectionStatus.self, forKey: .modelConnectionStatus)
    }

    var id: String { target.key }
    var target: V2ModelTarget { .init(connectorId: connectorId, runtimeId: runtimeId) }
}

nonisolated struct V2TokensLinkAccount: Decodable, Hashable {
    let id: String
    let displayName: String?
    let email: String?

    var label: String { displayName ?? email ?? id }
}

nonisolated struct V2TokensLink: Decodable, Hashable {
    /// "linked" or "reauth_required".
    let status: String
    let issuer: String?
    let account: V2TokensLinkAccount
    let linkedAt: String?
    let relinkSoon: Bool

    private enum CodingKeys: String, CodingKey { case status, issuer, account, linkedAt, relinkSoon }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decode(String.self, forKey: .status)
        issuer = try? container.decodeIfPresent(String.self, forKey: .issuer)
        account = (try? container.decodeIfPresent(V2TokensLinkAccount.self, forKey: .account))
            ?? V2TokensLinkAccount(id: "", displayName: nil, email: nil)
        linkedAt = try? container.decodeIfPresent(String.self, forKey: .linkedAt)
        relinkSoon = (try? container.decodeIfPresent(Bool.self, forKey: .relinkSoon)) ?? false
    }

    var isLinked: Bool { status == "linked" }
}

nonisolated struct V2TokensLinkStatus: Decodable, Hashable {
    let available: Bool
    let tokensUrl: String?
    let secretConfigured: Bool
    let link: V2TokensLink?

    private enum CodingKeys: String, CodingKey { case available, tokensUrl, secretConfigured, link }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        available = (try? container.decodeIfPresent(Bool.self, forKey: .available)) ?? false
        tokensUrl = try? container.decodeIfPresent(String.self, forKey: .tokensUrl)
        secretConfigured = (try? container.decodeIfPresent(Bool.self, forKey: .secretConfigured)) ?? false
        link = try? container.decodeIfPresent(V2TokensLink.self, forKey: .link)
    }
}

// MARK: - Current channel and switching

/// Channel values: `native` (the device's own configuration), `tokens` (the
/// linked Tokens Anywhere account) or a manual profile ID.
nonisolated enum V2ModelChannel {
    static let native = "native"
    static let tokens = "tokens"
}

/// The last switch of the current channel or an override.
nonisolated struct V2ChannelSwitch: Decodable, Hashable {
    let revision: Int
    /// running, done or attention.
    let state: String
    let startedAt: String?
    let finishedAt: String?

    init(revision: Int, state: String, startedAt: String? = nil, finishedAt: String? = nil) {
        self.revision = revision; self.state = state; self.startedAt = startedAt; self.finishedAt = finishedAt
    }

    private enum CodingKeys: String, CodingKey { case revision, state, startedAt, finishedAt }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try container.decode(String.self, forKey: .state)
        revision = (try? container.decodeIfPresent(Int.self, forKey: .revision)) ?? 0
        startedAt = try? container.decodeIfPresent(String.self, forKey: .startedAt)
        finishedAt = try? container.decodeIfPresent(String.self, forKey: .finishedAt)
    }
}

/// One runtime's channel: what it should use, what it actually uses, and how
/// far its switch got. Unknown states and reasons stay strings.
nonisolated struct V2ChannelRuntime: Decodable, Hashable, Identifiable {
    let connectorId: V2ConnectorID
    let runtimeId: V2RuntimeID
    /// A channel chosen for this runtime only; nil follows the current channel.
    let override: String?
    let desired: String
    /// Changes only once the runtime is verified on the new channel.
    let actual: String
    /// applied, pending, waiting_online, switching, restoring,
    /// restored, failed or unsupported.
    let state: String
    /// preparing, activating or verifying while switching.
    let step: String?
    let reason: String?
    let message: String?
    let updatedAt: String?

    let desiredGeneration: Int?
    let appliedGeneration: Int?
    let observedAt: String?
    let retryAt: String?

    init(connectorId: V2ConnectorID, runtimeId: V2RuntimeID, override: String? = nil, desired: String, actual: String,
         state: String, step: String? = nil, reason: String? = nil, message: String? = nil,
         updatedAt: String? = nil, desiredGeneration: Int? = nil, appliedGeneration: Int? = nil,
         observedAt: String? = nil, retryAt: String? = nil) {
        self.connectorId = connectorId; self.runtimeId = runtimeId; self.override = override
        self.desired = desired; self.actual = actual; self.state = state; self.step = step
        self.reason = reason; self.message = message; self.updatedAt = updatedAt
        self.desiredGeneration = desiredGeneration; self.appliedGeneration = appliedGeneration
        self.observedAt = observedAt; self.retryAt = retryAt
    }

    private enum CodingKeys: String, CodingKey {
        case connectorId, runtimeId, override, desired, actual, state, step, reason, message, updatedAt
        case desiredGeneration, appliedGeneration, observedAt, retryAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        connectorId = try container.decode(String.self, forKey: .connectorId)
        runtimeId = try container.decode(String.self, forKey: .runtimeId)
        override = try? container.decodeIfPresent(String.self, forKey: .override)
        actual = (try? container.decodeIfPresent(String.self, forKey: .actual)) ?? V2ModelChannel.native
        desired = (try? container.decodeIfPresent(String.self, forKey: .desired)) ?? actual
        state = (try? container.decodeIfPresent(String.self, forKey: .state)) ?? "unsupported"
        step = try? container.decodeIfPresent(String.self, forKey: .step)
        reason = try? container.decodeIfPresent(String.self, forKey: .reason)
        message = try? container.decodeIfPresent(String.self, forKey: .message)
        updatedAt = try? container.decodeIfPresent(String.self, forKey: .updatedAt)
        desiredGeneration = try? container.decodeIfPresent(Int.self, forKey: .desiredGeneration)
        appliedGeneration = try? container.decodeIfPresent(Int.self, forKey: .appliedGeneration)
        observedAt = try? container.decodeIfPresent(String.self, forKey: .observedAt)
        retryAt = try? container.decodeIfPresent(String.self, forKey: .retryAt)
    }

    var id: String { target.key }
    var target: V2ModelTarget { .init(connectorId: connectorId, runtimeId: runtimeId) }
}

/// The current channel, every runtime's place in it, and the last switch.
/// `GET /model-config/channel`, every channel write and the snapshot's
/// `modelConfig.channel` return it.
nonisolated struct V2ModelChannelState: Decodable, Hashable {
    let channel: String
    let revision: Int
    /// The wire field `switch`; nil until the first switch.
    let progress: V2ChannelSwitch?
    let runtimes: [V2ChannelRuntime]

    init(channel: String, revision: Int, progress: V2ChannelSwitch? = nil, runtimes: [V2ChannelRuntime] = []) {
        self.channel = channel; self.revision = revision; self.progress = progress; self.runtimes = runtimes
    }

    private enum CodingKeys: String, CodingKey { case channel, revision, progress = "switch", runtimes }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        channel = (try? container.decodeIfPresent(String.self, forKey: .channel)) ?? V2ModelChannel.native
        revision = (try? container.decodeIfPresent(Int.self, forKey: .revision)) ?? 0
        progress = try? container.decodeIfPresent(V2ChannelSwitch.self, forKey: .progress)
        runtimes = (try? container.decodeIfPresent(V2LossyArray<V2ChannelRuntime>.self, forKey: .runtimes))?.values ?? []
    }

    func runtime(_ target: V2ModelTarget) -> V2ChannelRuntime? {
        runtimes.first { $0.connectorId == target.connectorId && $0.runtimeId == target.runtimeId }
    }

    /// The channel is current, chosen for a runtime, or in use somewhere.
    func uses(_ channel: String) -> Bool {
        self.channel == channel || runtimes.contains { $0.override == channel || $0.desired == channel || $0.actual == channel }
    }
}

nonisolated struct V2ChannelRequest: Encodable, Hashable {
    let channel: String
}

/// `channel: null` follows the current channel, so it is always sent.
nonisolated struct V2RuntimeChannelRequest: Encodable, Hashable {
    let channel: String?
    let confirmNativeGlobal: Bool

    private enum CodingKeys: String, CodingKey { case channel, confirmNativeGlobal }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let channel { try container.encode(channel, forKey: .channel) }
        else { try container.encodeNil(forKey: .channel) }
        if confirmNativeGlobal { try container.encode(true, forKey: .confirmNativeGlobal) }
    }
}

/// Retries every restored or failed runtime, or only the one named.
nonisolated struct V2ChannelRetryRequest: Encodable, Hashable {
    let connectorId: V2ConnectorID?
    let runtimeId: V2RuntimeID?

    init(_ target: V2ModelTarget? = nil) {
        connectorId = target?.connectorId; runtimeId = target?.runtimeId
    }
}

/// The dashboard snapshot's `modelConfig`: profiles, where they are in use,
/// the current channel with its switch progress, and the Tokens Anywhere link.
/// Never keys.
nonisolated struct V2ModelConfigOverview: Decodable, Hashable {
    let secretConfigured: Bool
    let profiles: [V2ModelProfile]
    let assignments: [V2ModelAssignment]
    let channel: V2ModelChannelState?
    let tokens: V2TokensLinkStatus?

    private enum CodingKeys: String, CodingKey { case secretConfigured, profiles, assignments, channel, tokens }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        secretConfigured = (try? container.decodeIfPresent(Bool.self, forKey: .secretConfigured)) ?? false
        profiles = (try? container.decodeIfPresent(V2LossyArray<V2ModelProfile>.self, forKey: .profiles))?.values ?? []
        assignments = (try? container.decodeIfPresent(V2LossyArray<V2ModelAssignment>.self, forKey: .assignments))?.values ?? []
        channel = try? container.decodeIfPresent(V2ModelChannelState.self, forKey: .channel)
        tokens = try? container.decodeIfPresent(V2TokensLinkStatus.self, forKey: .tokens)
    }

    func profile(id: String) -> V2ModelProfile? { profiles.first { $0.id == id } }
    func assignment(for target: V2ModelTarget) -> V2ModelAssignment? {
        assignments.first { $0.connectorId == target.connectorId && $0.runtimeId == target.runtimeId }
    }
    func usage(of profileID: String) -> Int { assignments.filter { $0.profileId == profileID }.count }
    /// The profile a Tokens Anywhere link provides, while it is linked.
    var activeTokensProfile: V2ModelProfile? { profiles.first { $0.isTokens && $0.isActive } }
}

/// Decodes the elements it can and drops the rest, so one entry a newer Server
/// shapes differently cannot hide the whole list.
nonisolated struct V2LossyArray<Element: Decodable>: Decodable {
    let values: [Element]

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var values: [Element] = []
        while !container.isAtEnd {
            if let value = try? container.decode(Element.self) { values.append(value) }
            else if (try? container.decode(JSONValue.self)) == nil { break }
        }
        self.values = values
    }
}

// MARK: - Requests and responses

nonisolated struct V2ModelProfileCreateRequest: Encodable, Hashable {
    let name: String
    let apiKey: String
    let offers: [V2ModelOffer]
}

nonisolated struct V2TokensLinkStart: Decodable, Hashable {
    let startUrl: String
}

/// The linked Tokens Anywhere account. Amounts are decimal yuan strings with
/// four places; add them as ten-thousandths, never as floating point.
nonisolated struct V2TokensAccountInfo: Decodable, Hashable {
    let account: V2TokensLinkAccount
    let balance: V2TokensBalance
    let links: V2TokensConsoleLinks

    private enum CodingKeys: String, CodingKey { case account, balance, links }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        account = (try? container.decodeIfPresent(V2TokensLinkAccount.self, forKey: .account))
            ?? V2TokensLinkAccount(id: "", displayName: nil, email: nil)
        balance = (try? container.decodeIfPresent(V2TokensBalance.self, forKey: .balance)) ?? V2TokensBalance()
        links = try container.decode(V2TokensConsoleLinks.self, forKey: .links)
    }
}

nonisolated struct V2TokensBalance: Decodable, Hashable {
    var balance: String?
    var available: String?
    var held: String?
    var bonus: String?

    init(balance: String? = nil, available: String? = nil, held: String? = nil, bonus: String? = nil) {
        self.balance = balance; self.available = available; self.held = held; self.bonus = bonus
    }

    private enum CodingKeys: String, CodingKey { case balance, available, held, bonus }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        balance = try? container.decodeIfPresent(String.self, forKey: .balance)
        available = try? container.decodeIfPresent(String.self, forKey: .available)
        held = try? container.decodeIfPresent(String.self, forKey: .held)
        bonus = try? container.decodeIfPresent(String.self, forKey: .bonus)
    }
}

/// Tokens Anywhere console pages, opened in the browser.
nonisolated struct V2TokensConsoleLinks: Decodable, Hashable {
    let console: String
    let billing: String
    let usage: String
}

/// One model's settled usage on one Beijing date.
nonisolated struct V2TokensUsageItem: Decodable, Hashable {
    let date: String
    let model: String?
    let requests: Int
    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let cacheWrite5mTokens: Int
    let cacheWrite1hTokens: Int
    let amountCharged: String

    init(date: String, model: String?, requests: Int = 0, inputTokens: Int = 0, outputTokens: Int = 0,
         cacheReadTokens: Int = 0, cacheWrite5mTokens: Int = 0, cacheWrite1hTokens: Int = 0, amountCharged: String = "0") {
        self.date = date; self.model = model; self.requests = requests
        self.inputTokens = inputTokens; self.outputTokens = outputTokens; self.cacheReadTokens = cacheReadTokens
        self.cacheWrite5mTokens = cacheWrite5mTokens; self.cacheWrite1hTokens = cacheWrite1hTokens
        self.amountCharged = amountCharged
    }

    private enum CodingKeys: String, CodingKey {
        case date, model, requests, inputTokens, outputTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens, amountCharged
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        date = try container.decode(String.self, forKey: .date)
        model = try? container.decodeIfPresent(String.self, forKey: .model)
        func count(_ key: CodingKeys) -> Int { (try? container.decodeIfPresent(Int.self, forKey: key)) ?? 0 }
        requests = count(.requests)
        inputTokens = count(.inputTokens)
        outputTokens = count(.outputTokens)
        cacheReadTokens = count(.cacheReadTokens)
        cacheWrite5mTokens = count(.cacheWrite5mTokens)
        cacheWrite1hTokens = count(.cacheWrite1hTokens)
        amountCharged = (try? container.decodeIfPresent(String.self, forKey: .amountCharged)) ?? "0"
    }

    var tokens: Int { inputTokens + outputTokens + cacheReadTokens + cacheWrite5mTokens + cacheWrite1hTokens }
}

/// The whole Tokens account's usage from `from` to `to`; quiet days are absent.
nonisolated struct V2TokensUsage: Decodable, Hashable {
    let from: String
    let to: String
    let items: [V2TokensUsageItem]

    init(from: String, to: String, items: [V2TokensUsageItem]) {
        self.from = from; self.to = to; self.items = items
    }

    private enum CodingKeys: String, CodingKey { case from, to, items }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        from = try container.decode(String.self, forKey: .from)
        to = try container.decode(String.self, forKey: .to)
        items = (try? container.decodeIfPresent(V2LossyArray<V2TokensUsageItem>.self, forKey: .items))?.values ?? []
    }
}

nonisolated struct V2TokensModelsSaveResponse: Decodable, Hashable {
    /// True when runtimes using Tokens get the change in the background.
    let applying: Bool

    private enum CodingKeys: String, CodingKey { case applying }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        applying = (try? container.decodeIfPresent(Bool.self, forKey: .applying)) ?? false
    }
}

nonisolated struct V2TokensUnlinkResponse: Decodable, Hashable {
    /// False when Tokens Anywhere did not confirm revoking the authorization.
    let revoked: Bool

    private enum CodingKeys: String, CodingKey { case revoked }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        revoked = (try? container.decodeIfPresent(Bool.self, forKey: .revoked)) ?? true
    }
}

nonisolated struct V2AllowInterruptRequest: Encodable, Hashable {
    let allowInterrupt: Bool
}
