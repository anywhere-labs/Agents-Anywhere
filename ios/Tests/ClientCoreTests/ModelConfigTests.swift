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
        #expect(model.rows.map(\.runtime.runtimeId) == ["rti_gateway"])
        #expect(model.rows.first?.assignment?.profileId == "mpr_test")
        #expect(model.rows.first?.deviceName == "Mac")
        #expect(model.rows.first?.isManagedInstance == true)
        #expect(model.profileName("mpr_test") == "Gateway")
        repository.invalidate()
        #expect(repository.runtimes.isEmpty && repository.modelConfig == nil)
    }

    @Test func previewNeverPreselectsGlobalChangesOrTooManyModels() throws {
        var object = try fixtureObject("modelPreview")
        var targets = object["targets"] as! [[String: Any]]
        var crowded = targets[0]; crowded["runtimeId"] = "rti_crowded"; crowded["tooManyModels"] = true
        targets.append(crowded); object["targets"] = targets
        let preview: V2ModelPreviewResponse = try decode(object)
        #expect(preview.targets.count == 4)
        #expect(preview.targets[0].replaces?.host == "old.example" && preview.targets[0].models?.limit == 64)
        #expect(preview.targets[1].requiresConfirmation && preview.targets[1].scope == "native_global")
        #expect(preview.targets[2].decision == "skip" && !preview.targets[2].canApply)
        #expect(!preview.targets[3].canApply)
        #expect(ModelConfigPresentation.initialSelection(preview.targets) == ["device/rti_gateway"])
        #expect(preview.targets[0].interruptedSessions == 2)
        #expect(preview.targets[1].interruptedSessions == 0)
        #expect(ModelConfigPresentation.previewDetail(preview.targets[2]) == ModelConfigPresentation.skipReason("model_connection_unsupported"))
    }

    @Test func applySheetRequiresConfirmationAndSendsOneKey() async throws {
        let transport = TestHTTPTransport()
        transport.respond = { call in
            try fixtureData(call.path.hasSuffix("/preview") ? "modelPreview" : "modelOperation")
        }
        let profile = try fixture("modelProfile", as: V2ModelProfile.self)
        let apply = ModelApplyModel(profile: profile, api: .init(transport: transport), idempotencyKey: "key-1", deviceName: { $0 })
        await apply.load()
        #expect(apply.selected == ["device/rti_gateway"])
        #expect(apply.interruptedSessions == 2 && !apply.needsNativeGlobal && apply.canApply)
        apply.toggle(apply.targets![2], true)
        #expect(!apply.selected.contains("device/rti_work"), "A skipped runtime cannot be chosen")
        apply.toggle(apply.targets![1], true)
        #expect(apply.needsNativeGlobal && !apply.canApply)
        apply.confirmNativeGlobal = true
        apply.allowInterrupt = true
        #expect(apply.canApply)
        let operation = try #require(await apply.apply())
        #expect(operation.appliedCount == 1 && operation.otherCount == 1)
        let body = try #require(transport.calls.last?.body)
        #expect(transport.calls.last?.path == "/model-config/assignments")
        #expect(body["profileId"]?.stringValue == "mpr_test")
        #expect(body["allowInterrupt"] == .bool(true) && body["confirmNativeGlobal"] == .bool(true))
        #expect(body["targets"]?.configArray?.count == 2)
        #expect(ModelConfigPresentation.operationMessage(operation) == .warning(String(localized: "Applied to \(1); \(1) not applied")))
    }

    @Test func knownErrorCodesReadAsUserText() {
        let error = HTTPError.server(statusCode: 409, message: "devices still use this profile",
            detail: .object(["code": .string("profile_in_use"), "message": .string("devices still use this profile")]))
        #expect(ModelConfigErrorText.text(error) == String(localized: "Devices still use this profile. Restore them first."))
        let unknown = HTTPError.server(statusCode: 500, message: "boom", detail: .object(["code": .string("mystery")]))
        #expect(ModelConfigErrorText.text(unknown) == String(localized: "That did not finish. Try again later."))
        #expect(ModelConfigErrorText.text(code: "secret_required") != nil)
    }

    @Test func presentationFollowsDeclaredValues() {
        #expect(ModelConfigPresentation.maturityBadge("beta") == .beta)
        #expect(ModelConfigPresentation.maturityBadge("experimental") == .experimental)
        #expect(ModelConfigPresentation.maturityBadge("stable") == nil)
        #expect(ModelConfigPresentation.maturityBadge(nil) == nil)
        #expect(ModelConfigPresentation.connectionTone("applied") == .ok)
        #expect(ModelConfigPresentation.connectionTone("saved_pending") == .progress)
        #expect(ModelConfigPresentation.connectionTone("failed") == .error)
        #expect(ModelConfigPresentation.connectionTone("managed_externally") == .warning)
        #expect(ModelConfigPresentation.connectionTone("future_state") == .neutral)
        #expect(ModelConfigPresentation.assignmentTone("applying") == .progress)
        #expect(ModelConfigPresentation.assignmentTone("modified") == .warning)
        #expect(ModelConfigPresentation.protocolLabel("future_protocol") == "future_protocol")
        #expect(ModelConfigPresentation.parseModelIDs(" a, b\nb\r\n\n c ,") == ["a", "b", "c"])
    }

    @Test func manualProfileDraftNeedsANameKeyAndHTTPAddresses() throws {
        var draft = ModelProfileDraft()
        #expect(!draft.isValid)
        draft.name = " Gateway "; draft.apiKey = " sk-test "
        draft.offers[.openaiChat]?.baseURL = "ftp://gateway.example"
        #expect(!draft.isValid)
        draft.offers[.openaiChat]?.baseURL = "https://gateway.example/v1"
        draft.offers[.openaiChat]?.models = "gpt-test\n\ngpt-test"
        #expect(draft.isValid)
        let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(draft.request))
        let backend = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: (try fixtureObject("requests"))["createModelProfile"]!))
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

@Suite @MainActor struct QuickSetupTests {
    private func link(_ status: String, linkedAt: String = "2026-01-01T00:00:00Z") throws -> V2TokensLink {
        try decode(["status": status, "account": ["id": "a"], "linkedAt": linkedAt])
    }
    private func progress(_ state: String, step: String? = nil) throws -> V2QuickSetupProgress {
        var object: [String: Any] = ["state": state, "request": ["targets": [["connectorId": "c", "runtimeId": "codex"]], "confirmNativeGlobal": false], "startedAt": "2026-01-01T00:00:00Z"]
        if let step { object["step"] = step }
        return try decode(object)
    }
    private func candidates(_ items: [[String: Any]]) throws -> [V2ModelPreviewTarget] {
        try items.map { try decode($0) }
    }

    @Test func theCardShowsChoosingProgressOrDone() throws {
        let linked = try link("linked")
        #expect(QuickSetupPresentation.phase(link: nil, progress: nil, configured: false, authorizing: false) == .setup)
        #expect(QuickSetupPresentation.phase(link: nil, progress: nil, configured: false, authorizing: true) == .progress)
        #expect(QuickSetupPresentation.phase(link: linked, progress: try progress("syncing"), configured: false, authorizing: false) == .progress)
        #expect(QuickSetupPresentation.phase(link: linked, progress: try progress("failed", step: "apply"), configured: true, authorizing: false) == .progress)
        #expect(QuickSetupPresentation.phase(link: linked, progress: try progress("done"), configured: false, authorizing: false) == .done)
        #expect(QuickSetupPresentation.phase(link: linked, progress: nil, configured: true, authorizing: false) == .done)
        #expect(QuickSetupPresentation.phase(link: try link("reauth_required"), progress: nil, configured: true, authorizing: false) == .setup)
        #expect(QuickSetupPresentation.phase(link: nil, progress: try progress("syncing"), configured: false, authorizing: false) == .setup)
        // A linked account shows its own page, even before any runtime uses it.
        #expect(QuickSetupPresentation.phase(link: linked, progress: nil, configured: false, authorizing: false) == .done)
        // Changing models on a configured account keeps the account page in view.
        #expect(QuickSetupPresentation.phase(link: linked, progress: try progress("applying"), configured: true, authorizing: false) == .done)
        #expect(QuickSetupPresentation.phase(link: linked, progress: try progress("syncing"), configured: true, authorizing: false) == .done)
    }

    @Test func runningMeansSyncingOrApplying() throws {
        #expect(QuickSetupPresentation.isRunning(try progress("syncing")))
        #expect(QuickSetupPresentation.isRunning(try progress("applying")))
        #expect(!QuickSetupPresentation.isRunning(try progress("done")))
        #expect(!QuickSetupPresentation.isRunning(try progress("failed", step: "apply")))
        #expect(!QuickSetupPresentation.isRunning(nil))
    }

    @Test func eachStepReadsFromTheLinkAndItsProgress() throws {
        let linked = try link("linked")
        #expect(QuickSetupPresentation.steps(link: nil, progress: nil, authorizing: true) == .init(authorize: .active, sync: .pending, apply: .pending))
        #expect(QuickSetupPresentation.steps(link: nil, progress: nil, authorizing: false) == .init(authorize: .pending, sync: .pending, apply: .pending))
        #expect(QuickSetupPresentation.steps(link: linked, progress: nil, authorizing: false) == .init(authorize: .done, sync: .pending, apply: .pending))
        #expect(QuickSetupPresentation.steps(link: linked, progress: try progress("syncing"), authorizing: false) == .init(authorize: .done, sync: .active, apply: .pending))
        #expect(QuickSetupPresentation.steps(link: linked, progress: try progress("failed", step: "sync"), authorizing: false) == .init(authorize: .done, sync: .failed, apply: .pending))
        #expect(QuickSetupPresentation.steps(link: linked, progress: try progress("failed", step: "apply"), authorizing: false) == .init(authorize: .done, sync: .done, apply: .failed))
        #expect(QuickSetupPresentation.steps(link: linked, progress: try progress("applying"), authorizing: false) == .init(authorize: .done, sync: .done, apply: .active))
        #expect(QuickSetupPresentation.steps(link: linked, progress: try progress("done"), authorizing: false) == .init(authorize: .done, sync: .done, apply: .done))
    }

    @Test func runtimesChangingTheirOwnSettingsAreNotTickedByDefault() throws {
        let items = try candidates([
            ["connectorId": "c", "runtimeId": "codex", "decision": "apply"],
            ["connectorId": "c", "runtimeId": "dsh", "decision": "apply", "requiresConfirmation": true],
            ["connectorId": "d", "runtimeId": "codex", "decision": "skip", "reason": "device_offline"],
        ])
        #expect(QuickSetupPresentation.defaultSelection(items) == ["c/codex"])
        let request = QuickSetupPresentation.request(candidates: items, selection: ["c/codex", "d/codex"])
        #expect(request.targets == [.init(connectorId: "c", runtimeId: "codex")] && !request.confirmNativeGlobal)
        #expect(QuickSetupPresentation.request(candidates: items, selection: ["c/codex", "c/dsh"]).confirmNativeGlobal)
        #expect(QuickSetupPresentation.candidateNote(items[1]) == String(localized: "Changes its own global settings; set up only when ticked"))
        #expect(QuickSetupPresentation.candidateNote(items[2]) == ModelConfigPresentation.skipReason("device_offline"))
    }

    @Test func aRuntimeServedByAManagedInstanceIsNotNew() throws {
        let items = try candidates([
            ["connectorId": "c", "runtimeId": "codex", "runtimeType": "codex", "decision": "apply", "effect": "restart"],
            ["connectorId": "c", "runtimeId": "pi", "runtimeType": "pi", "decision": "apply", "effect": "new_instance"],
            ["connectorId": "c", "runtimeId": "claude", "runtimeType": "claude", "decision": "apply", "effect": "restart"],
        ])
        let assigned = [
            QuickAssignedTarget(connectorId: "c", runtimeId: "codex", runtimeType: nil, createdRuntime: false),
            QuickAssignedTarget(connectorId: "c", runtimeId: "pi-managed", runtimeType: "pi", createdRuntime: true),
        ]
        #expect(QuickSetupPresentation.newCandidates(items, assigned: assigned).map(\.runtimeId) == ["claude"])
        #expect(QuickSetupPresentation.candidateNote(items[1]) == String(localized: "Gets a separate managed instance; the original stays as it is"))
    }

    @Test func notesAndReasonsReadFromFields() throws {
        let busy = try candidates([["connectorId": "c", "runtimeId": "r", "decision": "apply", "effect": "restart", "runningSessions": 2]])[0]
        #expect(QuickSetupPresentation.candidateNote(busy) == String(localized: "Tasks are running; applies when idle"))
        #expect(QuickSetupPresentation.assignmentNote(status: "deferred", createdRuntime: false) == String(localized: "Tasks are running; applies when idle"))
        #expect(QuickSetupPresentation.assignmentNote(status: "applied", createdRuntime: true)
            == String(localized: "Applied") + String(localized: "pages.settings.modelConfigs.quick.viaManagedInstance"))
        #expect(ModelConfigPresentation.assignmentStatusLabel("deferred") == String(localized: "Applies when idle"))
        #expect(QuickSetupPresentation.reasonText("key_not_kept") == ModelConfigErrorText.text(code: "key_not_kept"))
        #expect(QuickSetupPresentation.reasonText("mystery") == ModelConfigPresentation.skipReason(nil))
        #expect(ModelConfigErrorText.text(code: "quick_setup_running") == String(localized: "A setup is already running."))
        #expect(QuickSetupPresentation.failureText(try progress("failed", step: "sync")) == String(localized: "That did not finish. Try again later."))
    }

    @Test func snapshotCarriesTheLastSetupAndToleratesOddShapes() throws {
        let snapshot: V2DashboardSnapshot = try fixture("dashboard")
        let quick = try #require(snapshot.modelConfig?.tokens?.quickSetup)
        #expect(quick.state == "done" && quick.request.confirmNativeGlobal && quick.request.targets.count == 2)
        #expect(quick.results.map(\.result) == ["deferred", "skipped"])
        #expect(quick.results[0].modelsTrimmed == 3 && quick.results.filter(\.isProblem).map(\.reason) == ["device_offline"])
        let odd: V2TokensLinkStatus = try decode(["available": true, "quickSetup": ["state": "syncing", "request": "?", "results": [["runtimeId": 1], ["connectorId": "c", "runtimeId": "r"]]]])
        #expect(odd.quickSetup?.request.targets == [] && odd.quickSetup?.results.count == 1)
        let broken: V2TokensLinkStatus = try decode(["available": true, "quickSetup": ["results": []]])
        #expect(broken.quickSetup == nil && broken.available)
    }

    @Test func modelStartsWithTheTickedRuntimesAndWaitsForTheBrowser() async throws {
        let transport = TestHTTPTransport()
        transport.respond = { call in
            call.method == .get ? try fixtureData("quickSetupCandidates") : try fixtureData("quickSetupStart")
        }
        let repository = V2DashboardRepository(service: .init(connectorAPI: V2ConnectorAPI(transport: transport),
            projectAPI: .init(transport: transport), sessionAPI: V2SessionAPI(transport: transport), realtimeAPI: TestRealtimeAPI()))
        repository.apply(try fixture("dashboard"))
        let model = ModelConfigModel(api: .init(transport: transport), dashboard: repository)
        // The fixture account is linked and its Tokens profile has no assignment, but the last setup is done.
        #expect(model.quickPhase == .done)
        await model.loadQuickCandidates()
        #expect(model.quickCandidates?.count == 3)
        #expect(model.effectiveQuickSelection == ["device/rti_gateway"])
        #expect(model.freshQuickCandidates.map(\.runtimeId) == ["rti_gateway", "rti_global"])
        #expect(model.showsQuickChoices && model.initialAccountTab == .devices)
        model.chooseNewQuickCandidates()
        // Choosing new runtimes happens on the account page's Devices tab.
        #expect(model.quickPhase == .done && model.quickChoosing && model.effectiveQuickSelection == ["device/rti_gateway"])
        model.toggleQuick(model.quickCandidates![2], true)
        #expect(!model.effectiveQuickSelection.contains("device/rti_work"), "A skipped runtime cannot be ticked")
        model.toggleQuick(model.quickCandidates![1], true)
        let url = await model.startQuickSetup()
        #expect(url?.absoluteString == "https://example.test/api/v2/integrations/tokens/start?ticket=quick")
        #expect(model.quickAuthorizing && !model.quickChoosing)
        let body = try #require(transport.calls.last?.body)
        #expect(transport.calls.last?.path == "/integrations/tokens/quick-setup" && transport.calls.last?.method == .post)
        #expect(body["confirmNativeGlobal"] == .bool(true) && body["targets"]?.configArray?.count == 2)
        model.finishAuthorizing()
        #expect(!model.quickAuthorizing)

        transport.respond = { _ in throw HTTPError.server(statusCode: 409, message: "running", detail: .object(["code": .string("quick_setup_running")])) }
        #expect(await model.startQuickSetup(retrying: .init(targets: [.init(connectorId: "device", runtimeId: "rti_gateway")], confirmNativeGlobal: false)) == nil)
        #expect(model.feedback == .error(String(localized: "A setup is already running.")))
    }
}
