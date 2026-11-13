import Foundation

nonisolated enum ModelStatusTone: Hashable {
    case ok, progress, warning, error, neutral
}

/// Labels and decisions for the model configuration page. Everything renders
/// from the runtime's declared capability; nothing branches on runtime names.
nonisolated enum ModelConfigPresentation {
    /// Stable runtimes show no badge; the others say how far along they are.
    static func maturityBadge(_ maturity: String?) -> V2RuntimeMaturity? {
        switch maturity {
        case V2RuntimeMaturity.beta.rawValue: .beta
        case V2RuntimeMaturity.experimental.rawValue: .experimental
        default: nil
        }
    }

    static func maturityLabel(_ maturity: V2RuntimeMaturity) -> String {
        switch maturity {
        case .beta: String(localized: "Beta")
        case .experimental: String(localized: "Experimental")
        case .stable: ""
        }
    }

    static func maturityDescription(_ maturity: V2RuntimeMaturity) -> String {
        switch maturity {
        case .beta: String(localized: "Mostly works; issues may remain.")
        case .experimental: String(localized: "Early feature; behavior may change. Use with care.")
        case .stable: ""
        }
    }

    static func protocolLabel(_ value: String) -> String {
        switch V2ModelProtocol(rawValue: value) {
        case .openaiResponses: String(localized: "OpenAI Responses")
        case .openaiChat: String(localized: "OpenAI Chat Completions")
        case .anthropic: String(localized: "Anthropic Messages")
        case nil: value
        }
    }

    static func sourceLabel(_ source: String) -> String {
        source == "tokens" ? String(localized: "Tokens Anywhere") : String(localized: "Manual")
    }

    /// Model IDs from a free-form list: one per line or separated by commas.
    static func parseModelIDs(_ text: String) -> [String] {
        var seen: Set<String> = []
        var result: [String] = []
        // "\r\n" is one Character, so split on scalars rather than characters.
        for raw in text.components(separatedBy: CharacterSet(charactersIn: ",\n\r")) {
            let id = raw.trimmingCharacters(in: .whitespaces)
            if !id.isEmpty, seen.insert(id).inserted { result.append(id) }
        }
        return result
    }

    /// Short enough for a tag; the full protocol name shows in the expanded details.
    static func protocolShortLabel(_ value: String) -> String {
        switch V2ModelProtocol(rawValue: value) {
        case .openaiResponses: "Responses"
        case .openaiChat: "Chat Completions"
        case .anthropic: "Anthropic"
        case nil: value
        }
    }

    static func offerSummary(_ offer: V2ModelOffer) -> String {
        let models = offer.models.isEmpty
            ? String(localized: "Models discovered")
            : String(localized: "\(offer.models.count) models")
        return "\(protocolShortLabel(offer.format))  \(models)"
    }
}

nonisolated enum ModelConfigFeedback: Hashable {
    case success(String)
    case warning(String)
    case error(String)

    var message: String {
        switch self { case let .success(text), let .warning(text), let .error(text): text }
    }
}

/// Known Server error codes in the user's language; the rest read as generic.
nonisolated enum ModelConfigErrorText {
    static func text(_ error: Error) -> String {
        if let code = (error as? HTTPError)?.serverCode, let text = text(code: code) { return text }
        if error is URLError { return error.localizedDescription }
        return String(localized: "That did not finish. Try again later.")
    }

    static func text(code: String) -> String? {
        switch code {
        case "secret_unconfigured": String(localized: "The server has no AGENT_SERVER_SECRET (at least 32 characters) yet, so it cannot keep keys or link accounts.")
        case "secret_required": String(localized: "The address changed. Enter the API key again.")
        case "profile_changed": String(localized: "This profile was changed elsewhere. Refresh and try again.")
        case "profile_in_use": String(localized: "This profile is a channel in use. Switch to another channel first.")
        case "profile_read_only": String(localized: "This profile is managed by its source and cannot be edited here.")
        case "profile_detached": String(localized: "This profile is unlinked and can no longer be used.")
        case "busy": String(localized: "Tasks are running. Allow interrupting them to continue.")
        case "too_many_models": String(localized: "Too many models. Import fewer.")
        case "confirmation_required": String(localized: "This changes the runtime's own global settings and needs confirmation.")
        case "channel_not_found": String(localized: "That channel no longer exists.")
        case "channel_in_use": String(localized: "Runtimes still use the Anywhere channel. Switch them to another channel first.")
        case "runtime_switching": String(localized: "The runtime is switching channels. Try again shortly.")
        case "tokens_unconfigured": String(localized: "This instance has no Tokens Anywhere address yet.")
        case "tokens_not_linked": String(localized: "Link Tokens Anywhere first.")
        case "reauth_required": String(localized: "The Tokens Anywhere authorization expired. Link again.")
        case "rotation_pending": String(localized: "A previous key rotation is still being checked. Try again shortly.")
        case "tokens_unavailable": String(localized: "Tokens Anywhere is unavailable right now.")
        case "tokens_not_synced": String(localized: "Sync the Tokens Anywhere models first.")
        case "key_rejected": String(localized: "Tokens Anywhere refused this instance's key.")
        case "catalog_empty": String(localized: "This key reaches no models yet.")
        case "link_expired": String(localized: "The link expired. Start again.")
        case "invalid_state": String(localized: "The link was not started in this browser. Start again.")
        case "invalid_issuer": String(localized: "The answer did not come from the configured Tokens Anywhere address.")
        case "access_denied": String(localized: "Authorization was cancelled.")
        case "authorization_failed": String(localized: "Tokens Anywhere did not finish the authorization.")
        case "exchange_failed": String(localized: "Tokens Anywhere did not issue a token. Try again.")
        case "model_connection_unsupported": String(localized: "This runtime takes no model connection.")
        case "device_offline": String(localized: "The device is offline.")
        case "key_not_kept": String(localized: "Tokens Anywhere did not keep this instance's key, so it cannot be fetched again. Ask its operator to set TOKENS_SECRETS_KEY, then unlink and link again.")
        case "models_required": String(localized: "This runtime needs at least one imported model.")
        case "gateway_address_not_allowed": String(localized: "This address is on a private network, which the server does not call, so it can't be detected.")
        case "gateway_unreachable": String(localized: "The server could not reach this address. Check the address.")
        case "gateway_key_rejected": String(localized: "The model service refused this key. Check it and try again.")
        case "gateway_protocols_unknown": String(localized: "Couldn't detect any supported protocol at this address. Check the address.")
        default: nil
        }
    }
}

/// The add-profile form. The key is write-only: it is sent once and never shown.
/// The Server detects the protocols and models from the address; only when it
/// cannot does the form switch to entering them by hand.
nonisolated struct ModelProfileDraft: Hashable {
    struct Offer: Hashable {
        var enabled = false
        var baseURL = ""
        var models = ""
    }

    /// Detection failures after which the protocols can still be entered by hand.
    static let manualFallbackCodes: Set<String> = [
        "gateway_address_not_allowed", "gateway_unreachable", "gateway_protocols_unknown",
    ]

    var name = ""
    var apiKey = ""
    /// The address the Server detects from; unused once the form is manual.
    var baseURL = ""
    var isManual = false
    var offers: [V2ModelProtocol: Offer] = [.openaiChat: Offer(enabled: true)]

    func offer(_ format: V2ModelProtocol) -> Offer { offers[format] ?? Offer() }

    var chosen: [V2ModelProtocol] { V2ModelProtocol.allCases.filter { offer($0).enabled } }

    var isValid: Bool {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        guard isManual else { return Self.isHTTPURL(baseURL) }
        return !chosen.isEmpty && chosen.allSatisfy { Self.isHTTPURL(offer($0).baseURL) }
    }

    var request: V2ModelProfileCreateRequest {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let apiKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isManual else {
            return .init(name: name, apiKey: apiKey, baseUrl: baseURL.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return .init(name: name, apiKey: apiKey, offers: chosen.map { format in
            let value = offer(format)
            return V2ModelOffer(format: format.rawValue, baseUrl: value.baseURL.trimmingCharacters(in: .whitespacesAndNewlines),
                models: ModelConfigPresentation.parseModelIDs(value.models).map { V2ModelSpec(id: $0) })
        })
    }

    /// After a failed detection the form turns manual, with each protocol's
    /// address taken from the entered one; returns whether it did.
    @discardableResult
    mutating func fallBackToManual(after code: String?) -> Bool {
        guard !isManual, let code, Self.manualFallbackCodes.contains(code) else { return false }
        for format in V2ModelProtocol.allCases {
            offers[format, default: .init()].baseURL = Self.protocolBaseURL(baseURL, for: format)
        }
        isManual = true
        return true
    }

    /// A protocol's address from the one entered: Anthropic clients add `/v1` themselves.
    static func protocolBaseURL(_ address: String, for format: V2ModelProtocol) -> String {
        var url = address.trimmingCharacters(in: .whitespacesAndNewlines)
        while url.hasSuffix("/") { url.removeLast() }
        if format == .anthropic, url.hasSuffix("/v1") { url.removeLast(3) }
        return url
    }

    static func isHTTPURL(_ text: String) -> Bool {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.contains(where: \.isWhitespace), let url = URL(string: value),
              let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = url.host, !host.isEmpty else { return false }
        return true
    }
}

/// Watches the snapshot while a Tokens Anywhere link runs in a browser. The
/// link never calls back into the app; it ends on the Tokens "done" page, so
/// the app learns the result from the next snapshot instead.
nonisolated struct TokensLinkWatch: Hashable {
    private let startedLinkedAt: String?
    private let startedLinked: Bool

    init(current link: V2TokensLink?) {
        startedLinked = link?.isLinked == true
        startedLinkedAt = link?.linkedAt
    }

    /// True once the snapshot shows a link newer than the one at the start.
    func isFinished(by link: V2TokensLink?) -> Bool {
        guard let link, link.isLinked else { return false }
        return !startedLinked || link.linkedAt != startedLinkedAt
    }
}
