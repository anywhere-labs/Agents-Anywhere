import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct ModelConfigTests {
    private func dashboardObject() throws -> [String: Any] { try fixtureObject("dashboard") }

    @Test func snapshotCarriesRuntimesAndModelConfigWithoutSecrets() throws {
        let snapshot: V2DashboardSnapshot = try fixture("dashboard")
        let runtimes = try #require(snapshot.runtimes)
        #expect(runtimes.map(\.runtimeId) == ["rti_work", "rti_gateway"])
        let gateway = runtimes[1]
        #expect(gateway.maturity == "beta" && gateway.badgeMaturity == "beta")
        #expect(gateway.modelConnection?.configField == "modelGateway")
        #expect(gateway.modelConnection?.protocols == ["openai_responses", "openai_chat"])
        #expect(gateway.modelConnection?.scope == "instance" && gateway.modelConnection?.apply == "restart")
        #expect(gateway.modelConnectionStatus?.state == "saved_pending")
        #expect(gateway.secretFields?["modelGateway.apiKey"] == V2RuntimeSecretField(isSet: true, hint: "sk-gate…1234"))
        #expect(gateway.config?["modelGateway"]?["apiKey"] == nil)
        #expect(gateway.managedBy == "model-config")
        #expect(runtimes[0].modelConnection == nil && runtimes[0].maturity == nil)

        let overview = try #require(snapshot.modelConfig)
        #expect(overview.secretConfigured)
        #expect(overview.profiles.map(\.id) == ["mpr_test", "mpr_tokens"])
        #expect(overview.profiles[0].keyHint == "sk-gate…1234" && overview.profiles[0].modelCount == 1)
        #expect(overview.activeTokensProfile?.id == "mpr_tokens")
        #expect(overview.usage(of: "mpr_test") == 1)
        let assignment = try #require(overview.assignment(for: gateway.target))
        #expect(assignment.status == "applied" && assignment.offerFormat == "openai_chat")
        #expect(overview.tokens?.available == true && overview.tokens?.link?.isLinked == true)
        #expect(overview.tokens?.link?.account.label == "Test")
        let channel = try #require(overview.channel)
        #expect(channel.channel == "mpr_test" && channel.revision == 3)
        #expect(channel.progress == V2ChannelSwitch(revision: 3, state: "attention", startedAt: "2026-09-05T12:00:00Z", finishedAt: "2026-09-05T12:00:00Z"))
        #expect(channel.runtimes.map(\.state) == ["unsupported", "applied", "restored"])
        #expect(channel.runtime(gateway.target)?.actual == "mpr_test")
        #expect(channel.runtimes[2].override == "tokens" && channel.runtimes[2].reason == "verify_timeout")
    }

    @Test func newSnapshotFieldsNeverBreakTheDashboard() throws {
        var object = try dashboardObject()
        var runtimes = object["runtimes"] as! [[String: Any]]
        runtimes[0]["status"] = "hibernating"
        runtimes.append(["runtimeId": 42])
        object["runtimes"] = runtimes
        object["modelConfig"] = ["profiles": "not a list", "tokens": ["available": "yes"]]
        let snapshot: V2DashboardSnapshot = try decode(object)
        #expect(snapshot.connectors.count == 1)
        #expect(snapshot.runtimes?.count == 2)
        #expect(snapshot.runtimes?.first?.status == .unknown)
        #expect(snapshot.modelConfig?.profiles == [])
        #expect(snapshot.modelConfig?.tokens?.available == false)

        object.removeValue(forKey: "runtimes"); object.removeValue(forKey: "modelConfig")
        let older: V2DashboardSnapshot = try decode(object)
        #expect(older.runtimes == nil && older.modelConfig == nil)

        object["modelConfig"] = 7
        let malformed: V2DashboardSnapshot = try decode(object)
        #expect(malformed.modelConfig == nil && malformed.sessions.count == 1)
    }

    @Test func repositoryKeepsTheLatestPushedRuntimesAndModelConfig() throws {
        let transport = TestHTTPTransport()
        let repository = V2DashboardRepository(service: .init(connectorAPI: V2ConnectorAPI(transport: transport),
            projectAPI: .init(transport: transport), sessionAPI: V2SessionAPI(transport: transport), realtimeAPI: TestRealtimeAPI()))
        repository.apply(try fixture("dashboard"))
        #expect(repository.runtimes.count == 2)
        #expect(repository.modelConfig?.profiles.count == 2)
        // A snapshot without the fields keeps what an earlier push delivered.
        var object = try dashboardObject()
        object.removeValue(forKey: "runtimes"); object.removeValue(forKey: "modelConfig")
        repository.apply(try decode(object, as: V2DashboardSnapshot.self))
        #expect(repository.runtimes.count == 2 && repository.modelConfig != nil)
        let model = ModelConfigModel(api: .init(transport: transport), dashboard: repository)
        let channel = try #require(model.channel)
        let groups = ChannelPresentation.groups(channel, runtimes: repository.runtimes, connectors: repository.connectors)
        #expect(groups.devices.map(\.name) == ["Mac"])
        #expect(groups.devices.first?.rows.map(\.runtimeName) == ["Gateway", "rti_global"])
        #expect(groups.unsupported.map(\.runtimeName) == ["Work"])
        #expect(model.profileName("mpr_test") == "Gateway")
        #expect(model.runtimeCount(using: "mpr_test") == 1 && model.runtimeCount(using: "native") == 2)
        repository.invalidate()
        #expect(repository.runtimes.isEmpty && repository.modelConfig == nil)
    }

    @Test func knownErrorCodesReadAsUserText() {
        let error = HTTPError.server(statusCode: 409, message: "devices still use this profile",
            detail: .object(["code": .string("profile_in_use"), "message": .string("devices still use this profile")]))
        #expect(ModelConfigErrorText.text(error) == String(localized: "This profile is a channel in use. Switch to another channel first."))
        let unknown = HTTPError.server(statusCode: 500, message: "boom", detail: .object(["code": .string("mystery")]))
        #expect(ModelConfigErrorText.text(unknown) == String(localized: "That did not finish. Try again later."))
        #expect(ModelConfigErrorText.text(code: "secret_required") != nil)
        #expect(ModelConfigErrorText.text(code: "channel_in_use") != nil && ModelConfigErrorText.text(code: "runtime_switching") != nil)
        for code in ["gateway_address_not_allowed", "gateway_unreachable", "gateway_key_rejected", "gateway_protocols_unknown"] {
            #expect(ModelConfigErrorText.text(code: code) != nil, "\(code) reads as user text")
        }
    }

    @Test func presentationFollowsDeclaredValues() {
        #expect(ModelConfigPresentation.maturityBadge("beta") == .beta)
        #expect(ModelConfigPresentation.maturityBadge("experimental") == .experimental)
        #expect(ModelConfigPresentation.maturityBadge("stable") == nil)
        #expect(ModelConfigPresentation.maturityBadge(nil) == nil)
        #expect(ModelConfigPresentation.protocolLabel("future_protocol") == "future_protocol")
        #expect(ModelConfigPresentation.parseModelIDs(" a, b\nb\r\n\n c ,") == ["a", "b", "c"])
    }

    @Test func profileDraftSendsOnlyTheAddressForTheServerToDetect() throws {
        var draft = ModelProfileDraft()
        #expect(!draft.isManual && !draft.isValid)
        draft.name = " Gateway "; draft.apiKey = " sk-test "
        #expect(!draft.isValid, "Detection needs an address")
        draft.baseURL = "gateway.example/v1"
        #expect(!draft.isValid)
        draft.baseURL = " https://gateway.example/v1 "
        #expect(draft.isValid, "Protocols are not chosen before detection")
        draft.offers[.openaiChat]?.enabled = false
        #expect(draft.isValid)
        let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(draft.request))
        let backend = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: (try fixtureObject("requests"))["detectModelProfile"]!))
        #expect(encoded == backend, "No offers, not even as null")
    }

    @Test func onlyAnAddressTheServerCannotDetectFromTurnsTheDraftManual() throws {
        var draft = ModelProfileDraft()
        draft.name = "Gateway"; draft.apiKey = "sk-test"; draft.baseURL = " https://gateway.example/v1/ "
        let afterKey = draft.fallBackToManual(after: "gateway_key_rejected")
        #expect(!afterKey && !draft.isManual, "A refused key keeps detecting")
        let afterNothing = draft.fallBackToManual(after: nil), afterOther = draft.fallBackToManual(after: "profile_changed")
        #expect(!afterNothing && !afterOther && !draft.isManual)
        let afterUnreachable = draft.fallBackToManual(after: "gateway_unreachable")
        #expect(afterUnreachable && draft.isManual)
        #expect(draft.offer(.openaiResponses).baseURL == "https://gateway.example/v1")
        #expect(draft.offer(.openaiChat).baseURL == "https://gateway.example/v1")
        #expect(draft.offer(.anthropic).baseURL == "https://gateway.example")
        #expect(draft.chosen == [.openaiChat], "Prefilling chooses no protocol")
        #expect(draft.isValid)
        let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(draft.request))
        #expect(encoded["baseUrl"] == nil && encoded["offers"]?.configArray?.count == 1)
        #expect(encoded["offers"]?.configArray?.first?["baseUrl"] == .string("https://gateway.example/v1"))
        draft.offers[.openaiChat]?.baseURL = "https://edited.example/v1"
        let again = draft.fallBackToManual(after: "gateway_protocols_unknown")
        #expect(!again, "A manual draft keeps what was entered")
        #expect(draft.offer(.openaiChat).baseURL == "https://edited.example/v1")
        for code in ["gateway_address_not_allowed", "gateway_protocols_unknown"] {
            var other = ModelProfileDraft()
            other.baseURL = "http://10.0.0.2:8080"
            let turnedManual = other.fallBackToManual(after: code)
            #expect(turnedManual && other.offer(.anthropic).baseURL == "http://10.0.0.2:8080")
        }
    }

    @Test func anthropicAddressDropsTheVersionTheClientAdds() {
        let address = "  https://gateway.example/api/v1//  "
        #expect(ModelProfileDraft.protocolBaseURL(address, for: .openaiResponses) == "https://gateway.example/api/v1")
        #expect(ModelProfileDraft.protocolBaseURL(address, for: .openaiChat) == "https://gateway.example/api/v1")
        #expect(ModelProfileDraft.protocolBaseURL(address, for: .anthropic) == "https://gateway.example/api")
        #expect(ModelProfileDraft.protocolBaseURL("https://gateway.example/v1beta", for: .anthropic) == "https://gateway.example/v1beta")
        #expect(ModelProfileDraft.protocolBaseURL("https://gateway.example", for: .anthropic) == "https://gateway.example")
        #expect(ModelProfileDraft.protocolBaseURL("", for: .anthropic) == "")
    }

    @Test func manualProfileDraftNeedsANameKeyAndHTTPAddresses() throws {
        var draft = ModelProfileDraft()
        draft.isManual = true
        #expect(!draft.isValid)
        draft.name = " Gateway "; draft.apiKey = " sk-test "
        draft.offers[.openaiChat]?.baseURL = "ftp://gateway.example"
        #expect(!draft.isValid)
        draft.offers[.openaiChat]?.baseURL = "https://gateway.example/v1"
        draft.offers[.openaiChat]?.models = "gpt-test\n\ngpt-test"
        #expect(draft.isValid)
        let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(draft.request))
        let backend = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: (try fixtureObject("requests"))["createModelProfile"]!))
        #expect(encoded["baseUrl"] == nil, "No address beside the offers, not even as null")
        #expect(encoded["name"] == backend["name"] && encoded["apiKey"] == backend["apiKey"])
        let offer = encoded["offers"]?.configArray?.first, backendOffer = backend["offers"]?.configArray?.first
        #expect(offer?["format"] == backendOffer?["format"])
        #expect(offer?["baseUrl"] == backendOffer?["baseUrl"])
        #expect(offer?["models"]?.configArray?.first?["id"] == .string("gpt-test"))
        #expect(offer?["models"]?.configArray?.count == 1)
        draft.offers[.anthropic] = .init(enabled: true, baseURL: "")
        #expect(!draft.isValid, "Every chosen protocol needs an address")
    }

    @Test func tokensLinkFinishesOnlyOnANewLink() throws {
        let linked = try JSONDecoder().decode(V2TokensLink.self, from: Data(#"{"status":"linked","issuer":"https://t","account":{"id":"a"},"linkedAt":"2026-01-01T00:00:00Z","relinkSoon":false}"#.utf8))
        let relinked = try JSONDecoder().decode(V2TokensLink.self, from: Data(#"{"status":"linked","issuer":"https://t","account":{"id":"a"},"linkedAt":"2026-02-01T00:00:00Z","relinkSoon":false}"#.utf8))
        let expired = try JSONDecoder().decode(V2TokensLink.self, from: Data(#"{"status":"reauth_required","account":{"id":"a"},"linkedAt":"2026-01-01T00:00:00Z"}"#.utf8))
        let fresh = TokensLinkWatch(current: nil)
        #expect(!fresh.isFinished(by: nil))
        #expect(fresh.isFinished(by: linked))
        let reauth = TokensLinkWatch(current: expired)
        #expect(!reauth.isFinished(by: expired))
        #expect(reauth.isFinished(by: linked))
        let again = TokensLinkWatch(current: linked)
        #expect(!again.isFinished(by: linked))
        #expect(again.isFinished(by: relinked))
    }
}

@Suite @MainActor struct WriteOnlyGatewayKeyTests {
    private func schema(protocols: [String] = []) throws -> V2RuntimeConfigSchema {
        var gateway: [String: JSONValue] = [
            "type": .string("object"), "required": .array([.string("baseUrl"), .string("apiKey")]),
            "additionalProperties": .bool(false),
            "properties": .object([
                "baseUrl": .object(["type": .string("string"), "minLength": .number(1)]),
                "apiKey": .object(["type": .string("string"), "minLength": .number(1)]),
            ]),
        ]
        if !protocols.isEmpty, case var .object(properties) = gateway["properties"]! {
            properties["protocol"] = .object(["type": .string("string"), "enum": .array(protocols.map(JSONValue.string))])
            gateway["properties"] = .object(properties)
        }
        return try .init(schema: .object(["type": .string("object"), "properties": .object(["modelGateway": .object(gateway)])]),
            uiSchema: .object(["modelGateway": .object(["component": .string("modelGateway")])]))
    }

    private let saved: [String: V2RuntimeSecretField] = ["modelGateway.apiKey": .init(isSet: true, hint: "sk-gate…1234")]
    private let config: JSONValue = .object(["modelGateway": .object(["baseUrl": .string("https://gateway.example/v1")])])

    @Test func emptyKeyKeepsTheSavedOneOnTheSameOrigin() throws {
        let draft = RuntimeConfigurationModel(schema: try schema(), config: config, secretFields: saved)
        #expect(draft.storedGatewayKey("modelGateway")?.hint == "sk-gate…1234")
        #expect(draft.gateways["modelGateway"]?.apiKey == "")
        #expect(try draft.makeConfig()["modelGateway"] == .object(["baseUrl": .string("https://gateway.example/v1")]))
        draft.gateways["modelGateway"]?.baseURL = "https://GATEWAY.example/v2"
        #expect(try draft.makeConfig()["modelGateway"]?["apiKey"] == nil, "A new path on the same origin keeps the key")
    }

    @Test func aNewAddressNeedsTheKeyAgain() throws {
        let draft = RuntimeConfigurationModel(schema: try schema(), config: config, secretFields: saved)
        draft.gateways["modelGateway"]?.baseURL = "https://elsewhere.example/v1"
        #expect(throws: RuntimeConfigurationValidationError.self) { try draft.makeConfig() }
        #expect(draft.errors["modelGateway"] == String(localized: "The address changed. Enter the API key again."))
        draft.gateways["modelGateway"]?.apiKey = "sk-new"
        #expect(try draft.makeConfig()["modelGateway"] == .object(["baseUrl": .string("https://elsewhere.example/v1"), "apiKey": .string("sk-new")]))
    }

    @Test func withoutASavedKeyTheKeyIsStillRequired() throws {
        let draft = RuntimeConfigurationModel(schema: try schema(), config: config)
        #expect(draft.storedGatewayKey("modelGateway") == nil)
        #expect(throws: RuntimeConfigurationValidationError.self) { try draft.makeConfig() }
    }

    @Test func protocolChoiceComesFromTheSchema() throws {
        let configured: JSONValue = .object(["modelGateway": .object(["baseUrl": .string("https://gateway.example/v1"), "protocol": .string("anthropic")])])
        let draft = RuntimeConfigurationModel(schema: try schema(protocols: ["openai_chat", "anthropic"]), config: configured, secretFields: saved)
        let field = try #require(draft.schema.fields.first)
        #expect(draft.gatewayProtocols(field) == ["openai_chat", "anthropic"])
        #expect(draft.gateways["modelGateway"]?.protocolValue == "anthropic")
        draft.gateways["modelGateway"]?.protocolValue = "openai_chat"
        #expect(try draft.makeConfig()["modelGateway"] == .object(["baseUrl": .string("https://gateway.example/v1"), "protocol": .string("openai_chat")]))
        let plain = RuntimeConfigurationModel(schema: try schema(), config: config, secretFields: saved)
        #expect(plain.gatewayProtocols(try #require(plain.schema.fields.first)).isEmpty)
    }

    @Test func originComparisonMatchesTheServer() {
        #expect(RuntimeConfigurationModel.sameOrigin("https://a.example/v1", "HTTPS://A.example/v2"))
        #expect(!RuntimeConfigurationModel.sameOrigin("https://a.example", "http://a.example"))
        #expect(!RuntimeConfigurationModel.sameOrigin("https://a.example:8443", "https://a.example"))
        #expect(RuntimeConfigurationModel.sameOrigin("https://a.example:443/v1", "https://a.example/v1"))
        #expect(!RuntimeConfigurationModel.sameOrigin("not a url", "not a url"))
    }
}

@Suite @MainActor struct ModelChannelTests {
    private func entry(_ runtimeId: String, _ state: String, connector: String = "device", desired: String = "tokens",
                       actual: String = "native", reason: String? = nil) -> V2ChannelRuntime {
        .init(connectorId: connector, runtimeId: runtimeId, desired: desired, actual: actual, state: state, reason: reason)
    }

    private func repository(_ transport: TestHTTPTransport) throws -> V2DashboardRepository {
        let repository = V2DashboardRepository(service: .init(connectorAPI: V2ConnectorAPI(transport: transport),
            projectAPI: .init(transport: transport), sessionAPI: V2SessionAPI(transport: transport), realtimeAPI: TestRealtimeAPI()))
        repository.apply(try fixture("dashboard"))
        return repository
    }

    private func push(_ repository: V2DashboardRepository, channel: [String: Any]) throws {
        var object = try fixtureObject("dashboard")
        var config = object["modelConfig"] as! [String: Any]
        config["channel"] = channel
        object["modelConfig"] = config
        repository.apply(try decode(object, as: V2DashboardSnapshot.self))
    }

    private func channelData(_ channel: String, revision: Int, state: String = "running") throws -> Data {
        var object = try fixtureObject("modelChannel")
        object["channel"] = channel; object["revision"] = revision
        object["switch"] = ["revision": revision, "state": state]
        return try JSONSerialization.data(withJSONObject: object)
    }

    @Test func channelStateKeepsUnknownValuesAndDropsBrokenRuntimes() throws {
        let state: V2ModelChannelState = try decode([
            "channel": "mpr_new", "revision": 9, "switch": ["revision": 9, "state": "paused", "startedAt": 7],
            "runtimes": [
                ["connectorId": "c", "runtimeId": "a", "desired": "tokens", "actual": "native", "state": "hibernating", "step": "warming"],
                ["runtimeId": "orphan"],
                ["connectorId": "c", "runtimeId": "b"],
            ],
        ])
        #expect(state.channel == "mpr_new" && state.revision == 9)
        #expect(state.progress?.state == "paused" && state.progress?.startedAt == nil)
        #expect(state.runtimes.map(\.runtimeId) == ["a", "b"])
        #expect(state.runtimes[0].state == "hibernating")
        #expect(ChannelPresentation.stateLabel(state.runtimes[0]) == "hibernating")
        #expect(ChannelPresentation.stateLabel(entry("x", "switching")) == String(localized: "pages.settings.modelConfigs.state.switching"))
        #expect(ChannelPresentation.tone("hibernating") == .neutral)
        // A runtime the Server reports with nothing else stays where it is.
        #expect(state.runtimes[1].actual == "native" && state.runtimes[1].desired == "native" && state.runtimes[1].state == "unsupported")
        #expect(state.uses("tokens") && !state.uses("mpr_old"))

        let never: V2ModelChannelState = try decode(["channel": "native", "revision": 0, "switch": NSNull(), "runtimes": "?"])
        #expect(never.progress == nil && never.runtimes.isEmpty)
        #expect(ChannelPresentation.progress(never.runtimes).phase == .none)
        var object = try fixtureObject("dashboard")
        var config = object["modelConfig"] as! [String: Any]
        config["channel"] = "tokens"
        object["modelConfig"] = config
        let odd: V2DashboardSnapshot = try decode(object)
        #expect(odd.modelConfig?.channel == nil && odd.modelConfig?.profiles.count == 2)
    }

    @Test func progressCountsTheRuntimesOfOneChannel() {
        let state = V2ModelChannelState(channel: "tokens", revision: 4, runtimes: [
            entry("a", "applied", actual: "tokens"), entry("b", "pending"), entry("c", "waiting_online"),
            entry("d", "switching"), entry("f", "unsupported", reason: "model_connection_unsupported"),
        ])
        let progress = ChannelPresentation.progress(ChannelPresentation.rows(state, for: "tokens"))
        #expect(progress == ChannelProgress(phase: .running, total: 4, applied: 1, unfinished: 3, offlineDevices: 1,
            restored: 0, failed: 0, unsupported: 1))
        let attention = ChannelPresentation.progress([entry("a", "failed", reason: "rollback_failed"), entry("b", "restored"), entry("c", "pending")])
        #expect(attention.phase == .attention && attention.failed == 1 && attention.restored == 1)
        #expect(ChannelPresentation.progress([entry("a", "applied")]).phase == .done)
        #expect(ChannelPresentation.rows(state, for: "mpr_other").isEmpty && ChannelPresentation.rows(nil, for: "tokens").isEmpty)
    }

    @Test func runtimesGroupByDeviceAndCapability() throws {
        let runtimes: [V2DeviceRuntime] = try fixture("dashboard", as: V2DashboardSnapshot.self).runtimes ?? []
        let connectors: [V2Connector] = try fixture("dashboard", as: V2DashboardSnapshot.self).connectors
        let state = V2ModelChannelState(channel: "tokens", revision: 1, runtimes: [
            entry("rti_work", "unsupported", reason: "model_connection_unsupported"),
            entry("rti_gateway", "waiting_idle"),
            entry("dsh", "unsupported", connector: "elsewhere", reason: "confirmation_required"),
            entry("gone", "unsupported", connector: "elsewhere", reason: "not_installed"),
        ])
        let groups = ChannelPresentation.groups(state, runtimes: runtimes, connectors: connectors)
        #expect(groups.devices.map(\.name) == ["Mac", "elsewhere"])
        #expect(groups.devices[0].rows.map(\.runtimeName) == ["Gateway"])
        #expect(groups.devices[0].rows[0].maturity == "beta")
        // A runtime that writes its own global settings waits for a confirmed choice.
        let global = groups.devices[1].rows[0]
        #expect(global.changesGlobalSettings && !global.isUnsupported)
        #expect(global.needsGlobalConfirmation(for: "tokens") && !global.needsGlobalConfirmation(for: nil)
            && !global.needsGlobalConfirmation(for: V2ModelChannel.native))
        #expect(groups.unsupported.map(\.runtimeName) == ["Work", "gone"])
        #expect(ChannelPresentation.reasonText(state.runtimes[0]) == String(localized: "pages.settings.modelConfigs.reason.model_connection_unsupported"))
        let unknown = V2ChannelRuntime(connectorId: "c", runtimeId: "r", desired: "tokens", actual: "native", state: "failed",
            reason: "mystery", message: "custom")
        #expect(ChannelPresentation.reasonText(unknown) == String(localized: "pages.settings.modelConfigs.reason.unknown"))
        #expect(ChannelPresentation.reasonText(entry("x", "applied")) == nil)
    }

    @Test func optionsOfferTheLinkedAccountAndActiveManualProfiles() throws {
        let overview = try #require(try fixture("dashboard", as: V2DashboardSnapshot.self).modelConfig)
        let options = ChannelPresentation.options(overview: overview, current: "mpr_test")
        #expect(options.map(\.id) == ["native", "tokens", "mpr_test"])
        #expect(options.map(\.kind) == [.native, .tokens, .profile])
        #expect(options[2].label == "Gateway")
        // A current channel that went away still shows, so the picker has a value.
        #expect(ChannelPresentation.options(overview: overview, current: "mpr_gone").last?.id == "mpr_gone")
        var object = try fixtureObject("dashboard")
        var config = object["modelConfig"] as! [String: Any]
        config["tokens"] = ["available": true, "link": NSNull()]
        object["modelConfig"] = config
        let unlinked = try #require(try decode(object, as: V2DashboardSnapshot.self).modelConfig)
        #expect(ChannelPresentation.options(overview: unlinked, current: "native").map(\.id) == ["native", "mpr_test"])
        #expect(ChannelPresentation.label("native", profiles: []) == String(localized: "pages.settings.modelConfigs.current.native"))
    }

    @Test func writesShowTheirAnswerUntilANewerPush() async throws {
        let transport = TestHTTPTransport()
        let repository = try repository(transport)
        let model = ModelConfigModel(api: .init(transport: transport), dashboard: repository)
        #expect(model.channel?.channel == "mpr_test")
        transport.respond = { _ in try self.channelData("tokens", revision: 4) }
        await model.setChannel("tokens")
        #expect(transport.calls.last?.method == .put && transport.calls.last?.path == "/model-config/channel")
        #expect(transport.calls.last?.body == .object(["channel": .string("tokens")]))
        #expect(model.channel?.channel == "tokens")
        #expect(model.channelBusyKey == nil)
        // Choosing the current channel again sends nothing.
        await model.setChannel("tokens")
        #expect(transport.calls.count == 1)

        // The next push replaces the answer.
        var pushed = try fixtureObject("modelChannel"); pushed["channel"] = "native"; pushed["revision"] = 5
        try push(repository, channel: pushed)
        #expect(model.channel?.channel == "native")
        // An answer older than the push is not shown.
        transport.respond = { _ in try self.channelData("tokens", revision: 4) }
        await model.retryChannel()
        #expect(transport.calls.last?.path == "/model-config/channel/retry" && transport.calls.last?.body == .object([:]))
        #expect(model.channel?.channel == "native")

        transport.respond = { _ in throw HTTPError.server(statusCode: 409, message: "not linked", detail: .object(["code": .string("tokens_not_linked")])) }
        await model.setChannel("tokens")
        #expect(model.feedback == .error(String(localized: "Link Tokens Anywhere first.")))
        #expect(model.channel?.channel == "native")
    }

    @Test func runtimeActionsTargetOneRuntime() async throws {
        let transport = TestHTTPTransport()
        let dashboard = try repository(transport)
        let model = ModelConfigModel(api: .init(transport: transport), dashboard: dashboard)
        transport.respond = { _ in try self.channelData("mpr_test", revision: 6) }
        let channel = try #require(model.channel)
        let rows = ChannelPresentation.groups(channel, runtimes: dashboard.runtimes, connectors: dashboard.connectors).devices.flatMap(\.rows)
        let gateway = try #require(rows.first { $0.entry.runtimeId == "rti_gateway" })
        let restored = try #require(rows.first { $0.entry.runtimeId == "rti_global" })
        #expect(restored.canRetry && restored.entry.override == "tokens")

        await model.setRuntimeChannel(gateway, channel: nil)
        #expect(transport.calls.last?.method == .put && transport.calls.last?.path == "/model-config/channel/runtimes/device/rti_gateway")
        #expect(transport.calls.last?.body == .object(["channel": .null]))
        // Confirmation is sent only for a runtime that changes its own global settings.
        await model.setRuntimeChannel(gateway, channel: "tokens", confirmNativeGlobal: true)
        #expect(transport.calls.last?.body == .object(["channel": .string("tokens")]))
        await model.retryChannel(restored)
        #expect(transport.calls.last?.body == .object(["connectorId": .string("device"), "runtimeId": .string("rti_global")]))
        #expect(model.channel?.revision == 6)

        let global = ChannelRuntimeRow(entry: restored.entry, runtimeName: "DSH", deviceName: "Mac", maturity: nil,
            changesGlobalSettings: true, isUnsupported: false)
        await model.setRuntimeChannel(global, channel: "tokens", confirmNativeGlobal: true)
        #expect(transport.calls.last?.body == .object(["channel": .string("tokens"), "confirmNativeGlobal": .bool(true)]))
    }

    @Test func rotationAsksBeforeInterrupting() async throws {
        let transport = TestHTTPTransport()
        let model = ModelConfigModel(api: .init(transport: transport), dashboard: try repository(transport))
        let tokens = try #require(model.overview?.activeTokensProfile)
        transport.respond = { _ in throw HTTPError.server(statusCode: 409, message: "busy", detail: .object(["code": .string("busy")])) }
        await model.rotateKey(tokens)
        #expect(model.pendingInterrupt == .rotate(tokens) && model.feedback == nil)
        transport.respond = { _ in try self.channelData("mpr_test", revision: 8) }
        await model.resumeInterrupted()
        #expect(transport.calls.map(\.body) == [.object(["allowInterrupt": .bool(false)]), .object(["allowInterrupt": .bool(true)])])
        #expect(model.feedback == .success(String(localized: "Key rotated. Runtimes using Anywhere get the new key.")))
        #expect(model.channel?.revision == 8, "The rewrite's progress shows at once")
        // The profile in the current channel, or one a runtime uses, cannot be deleted.
        #expect(model.isInUse(try #require(model.overview?.profile(id: "mpr_test"))))
        #expect(model.isInUse(tokens))
    }
}
