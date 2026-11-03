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
        default: nil
        }
    }
}

/// The add-profile form. The key is write-only: it is sent once and never shown.
nonisolated struct ModelProfileDraft: Hashable {
    struct Offer: Hashable {
        var enabled = false
        var baseURL = ""
        var models = ""
    }

    var name = ""
    var apiKey = ""
    var offers: [V2ModelProtocol: Offer] = [.openaiChat: Offer(enabled: true)]

    func offer(_ format: V2ModelProtocol) -> Offer { offers[format] ?? Offer() }

    var chosen: [V2ModelProtocol] { V2ModelProtocol.allCases.filter { offer($0).enabled } }

    var isValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !chosen.isEmpty
            && chosen.allSatisfy { Self.isHTTPURL(offer($0).baseURL) }
    }

    var request: V2ModelProfileCreateRequest {
        .init(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            apiKey: apiKey.trimmingCharacters(in: .whitespacesAndNewlines),
            offers: chosen.map { format in
                let value = offer(format)
                return V2ModelOffer(format: format.rawValue, baseUrl: value.baseURL.trimmingCharacters(in: .whitespacesAndNewlines),
                    models: ModelConfigPresentation.parseModelIDs(value.models).map { V2ModelSpec(id: $0) })
            })
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
