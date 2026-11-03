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
    /// applying, failed, modified, outdated or applied.
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
    /// The last one-click setup: what was ticked and how far it got.
    let quickSetup: V2QuickSetupProgress?

    private enum CodingKeys: String, CodingKey { case available, tokensUrl, secretConfigured, link, quickSetup }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        available = (try? container.decodeIfPresent(Bool.self, forKey: .available)) ?? false
        tokensUrl = try? container.decodeIfPresent(String.self, forKey: .tokensUrl)
        secretConfigured = (try? container.decodeIfPresent(Bool.self, forKey: .secretConfigured)) ?? false
        link = try? container.decodeIfPresent(V2TokensLink.self, forKey: .link)
        quickSetup = try? container.decodeIfPresent(V2QuickSetupProgress.self, forKey: .quickSetup)
    }
}

/// The runtimes a one-click setup was asked to configure.
nonisolated struct V2QuickSetupRequest: Codable, Hashable {
    let targets: [V2ModelTarget]
    let confirmNativeGlobal: Bool

    private enum CodingKeys: String, CodingKey { case targets, confirmNativeGlobal }

    init(targets: [V2ModelTarget], confirmNativeGlobal: Bool) {
        self.targets = targets; self.confirmNativeGlobal = confirmNativeGlobal
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        targets = (try? container.decodeIfPresent(V2LossyArray<V2ModelTarget>.self, forKey: .targets))?.values ?? []
        confirmNativeGlobal = (try? container.decodeIfPresent(Bool.self, forKey: .confirmNativeGlobal)) ?? false
    }
}

nonisolated struct V2QuickSetupResult: Decodable, Hashable, Identifiable {
    let connectorId: V2ConnectorID
    let runtimeId: V2RuntimeID
    /// applied, deferred, skipped or failed.
    let result: String
    let reason: String?
    let modelsTrimmed: Int?
    let servesRuntimeId: String?

    private enum CodingKeys: String, CodingKey { case connectorId, runtimeId, result, reason, modelsTrimmed, servesRuntimeId }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        connectorId = try container.decode(String.self, forKey: .connectorId)
        runtimeId = try container.decode(String.self, forKey: .runtimeId)
        result = (try? container.decodeIfPresent(String.self, forKey: .result)) ?? "failed"
        reason = try? container.decodeIfPresent(String.self, forKey: .reason)
        modelsTrimmed = try? container.decodeIfPresent(Int.self, forKey: .modelsTrimmed)
        servesRuntimeId = try? container.decodeIfPresent(String.self, forKey: .servesRuntimeId)
    }

    var id: String { target.key }
    var target: V2ModelTarget { .init(connectorId: connectorId, runtimeId: runtimeId) }
    var isProblem: Bool { result == "skipped" || result == "failed" }
}

/// Progress of a one-click setup, pushed with every snapshot.
nonisolated struct V2QuickSetupProgress: Decodable, Hashable {
    /// syncing, applying, done or failed.
    let state: String
    let request: V2QuickSetupRequest
    let startedAt: String?
    /// "sync" or "apply": where a failed setup stopped.
    let step: String?
    let code: String?
    let results: [V2QuickSetupResult]

    private enum CodingKeys: String, CodingKey { case state, request, startedAt, step, code, results }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try container.decode(String.self, forKey: .state)
        request = (try? container.decodeIfPresent(V2QuickSetupRequest.self, forKey: .request))
            ?? V2QuickSetupRequest(targets: [], confirmNativeGlobal: false)
        startedAt = try? container.decodeIfPresent(String.self, forKey: .startedAt)
        step = try? container.decodeIfPresent(String.self, forKey: .step)
        code = try? container.decodeIfPresent(String.self, forKey: .code)
        results = (try? container.decodeIfPresent(V2LossyArray<V2QuickSetupResult>.self, forKey: .results))?.values ?? []
    }
}

nonisolated struct V2QuickSetupCandidatesResponse: Decodable, Hashable {
    let targets: [V2ModelPreviewTarget]

    private enum CodingKeys: String, CodingKey { case targets }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        targets = (try? container.decodeIfPresent(V2LossyArray<V2ModelPreviewTarget>.self, forKey: .targets))?.values ?? []
    }
}

nonisolated struct V2QuickSetupStartResponse: Decodable, Hashable {
    let started: Bool
    /// The authorization page to open when the account has to link first.
    let startUrl: String?

    private enum CodingKeys: String, CodingKey { case started, startUrl }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        started = (try? container.decodeIfPresent(Bool.self, forKey: .started)) ?? false
        startUrl = try? container.decodeIfPresent(String.self, forKey: .startUrl)
    }
}

/// The dashboard snapshot's `modelConfig`: profiles, where they are applied,
/// and the Tokens Anywhere link. Never keys.
nonisolated struct V2ModelConfigOverview: Decodable, Hashable {
    let secretConfigured: Bool
    let profiles: [V2ModelProfile]
    let assignments: [V2ModelAssignment]
    let tokens: V2TokensLinkStatus?

    private enum CodingKeys: String, CodingKey { case secretConfigured, profiles, assignments, tokens }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        secretConfigured = (try? container.decodeIfPresent(Bool.self, forKey: .secretConfigured)) ?? false
        profiles = (try? container.decodeIfPresent(V2LossyArray<V2ModelProfile>.self, forKey: .profiles))?.values ?? []
        assignments = (try? container.decodeIfPresent(V2LossyArray<V2ModelAssignment>.self, forKey: .assignments))?.values ?? []
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

nonisolated struct V2ModelPreviewRequest: Encodable, Hashable {
    let profileId: String
}

nonisolated struct V2ModelPreviewReplacement: Decodable, Hashable {
    /// "profile" or "manual".
    let kind: String
    let profileId: String?
    let host: String
}

nonisolated struct V2ModelPreviewModels: Decodable, Hashable {
    let importing: Int
    let existing: Int
    let limit: Int
}

nonisolated struct V2ModelPreviewTarget: Decodable, Hashable, Identifiable {
    let connectorId: V2ConnectorID
    let runtimeId: V2RuntimeID
    let runtimeType: String
    let name: String?
    let maturity: String?
    /// "apply" or "skip".
    let decision: String
    let reason: String?
    let offerFormat: String?
    /// new_instance, immediate, new_session or restart.
    let effect: String?
    let scope: String?
    let requiresConfirmation: Bool
    let runningSessions: Int
    let replaces: V2ModelPreviewReplacement?
    let models: V2ModelPreviewModels?
    let tooManyModels: Bool
    let capabilityMaturity: String?

    private enum CodingKeys: String, CodingKey {
        case connectorId, runtimeId, runtimeType, name, maturity, decision, reason, offerFormat, effect, scope
        case requiresConfirmation, runningSessions, replaces, models, tooManyModels, capabilityMaturity
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        connectorId = try container.decode(String.self, forKey: .connectorId)
        runtimeId = try container.decode(String.self, forKey: .runtimeId)
        runtimeType = (try? container.decodeIfPresent(String.self, forKey: .runtimeType)) ?? ""
        name = try? container.decodeIfPresent(String.self, forKey: .name)
        maturity = try? container.decodeIfPresent(String.self, forKey: .maturity)
        decision = (try? container.decodeIfPresent(String.self, forKey: .decision)) ?? "skip"
        reason = try? container.decodeIfPresent(String.self, forKey: .reason)
        offerFormat = try? container.decodeIfPresent(String.self, forKey: .offerFormat)
        effect = try? container.decodeIfPresent(String.self, forKey: .effect)
        scope = try? container.decodeIfPresent(String.self, forKey: .scope)
        requiresConfirmation = (try? container.decodeIfPresent(Bool.self, forKey: .requiresConfirmation)) ?? false
        runningSessions = (try? container.decodeIfPresent(Int.self, forKey: .runningSessions)) ?? 0
        replaces = try? container.decodeIfPresent(V2ModelPreviewReplacement.self, forKey: .replaces)
        models = try? container.decodeIfPresent(V2ModelPreviewModels.self, forKey: .models)
        tooManyModels = (try? container.decodeIfPresent(Bool.self, forKey: .tooManyModels)) ?? false
        capabilityMaturity = try? container.decodeIfPresent(String.self, forKey: .capabilityMaturity)
    }

    var id: String { target.key }
    var target: V2ModelTarget { .init(connectorId: connectorId, runtimeId: runtimeId) }
    var canApply: Bool { decision == "apply" && !tooManyModels }
    /// Running tasks this target would interrupt; only a restart interrupts them.
    var interruptedSessions: Int { effect == "restart" ? runningSessions : 0 }
}

nonisolated struct V2ModelPreviewResponse: Decodable, Hashable {
    let targets: [V2ModelPreviewTarget]

    private enum CodingKeys: String, CodingKey { case targets }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        targets = (try? container.decodeIfPresent(V2LossyArray<V2ModelPreviewTarget>.self, forKey: .targets))?.values ?? []
    }
}

nonisolated struct V2ModelApplyRequest: Encodable, Hashable {
    let profileId: String
    let targets: [V2ModelTarget]
    let allowInterrupt: Bool
    let confirmNativeGlobal: Bool
}

nonisolated struct V2ModelOperationResult: Decodable, Hashable {
    let connectorId: V2ConnectorID
    let runtimeId: V2RuntimeID
    /// applied, skipped, failed or restored.
    let result: String
    let reason: String?
    let message: String?
}

nonisolated struct V2ModelOperation: Decodable, Hashable {
    let operationId: String?
    let kind: String?
    let finished: Bool
    let results: [V2ModelOperationResult]

    private enum CodingKeys: String, CodingKey { case operationId, kind, finished, results }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        operationId = try? container.decodeIfPresent(String.self, forKey: .operationId)
        kind = try? container.decodeIfPresent(String.self, forKey: .kind)
        finished = (try? container.decodeIfPresent(Bool.self, forKey: .finished)) ?? true
        results = (try? container.decodeIfPresent(V2LossyArray<V2ModelOperationResult>.self, forKey: .results))?.values ?? []
    }

    var appliedCount: Int { results.filter { $0.result == "applied" }.count }
    var otherCount: Int { results.count - appliedCount }
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
    let revoked: Bool
    let results: [V2ModelOperationResult]

    private enum CodingKeys: String, CodingKey { case revoked, results }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        revoked = (try? container.decodeIfPresent(Bool.self, forKey: .revoked)) ?? false
        results = (try? container.decodeIfPresent(V2LossyArray<V2ModelOperationResult>.self, forKey: .results))?.values ?? []
    }

    /// Runtimes that could not be put back before the authorization was revoked.
    var unrestoredCount: Int { results.filter { $0.result != "restored" }.count }
}

nonisolated struct V2AllowInterruptRequest: Encodable, Hashable {
    let allowInterrupt: Bool
}
