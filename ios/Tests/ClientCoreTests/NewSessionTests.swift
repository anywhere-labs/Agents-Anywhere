import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct NewSessionTests {
    private func make(_ http: TestHTTPTransport, defaults: UserDefaults? = nil, account: String = "one") -> NewSessionModel {
        let connectors = V2ConnectorAPI(transport: http)
        return NewSessionModel(scope: .init(serverURL: URL(string: "https://example.test")!, accountID: account),
            devices: .init(connectorAPI: connectors), preparation: .init(connectorAPI: connectors),
            creation: .init(sessionAPI: V2SessionAPI(transport: http)),
            defaults: defaults ?? UserDefaults(suiteName: "aa-tests-\(UUID().uuidString)")!)
    }
    private func transport() -> TestHTTPTransport {
        let http = TestHTTPTransport()
        http.respond = { call in
            if call.path.hasSuffix("/rti_work") { return try fixtureData("runtime") }
            if call.path.hasSuffix("/create-and-start") { return try fixtureData("session") }
            return try http.defaultResponse(call)
        }
        return http
    }
    private func devices(online: Bool = true) throws -> [V2Connector] {
        var object = try fixtureObject("connector")
        var device = object["connector"] as! [String: Any]
        device["status"] = online ? "online" : "offline"
        object["connector"] = device
        let response: V2ConnectorResponse = try decode(object)
        return [response.connector]
    }

    @Test func offlineDraftAndTargetSurviveAndReconnectRefreshesWithoutWrites() async throws {
        let http = transport(); let model = make(http)
        model.draft.text = "保留这个任务"
        await model.refresh(connectors: try devices())
        #expect(model.canCreate)
        #expect(model.runtimeID == "rti_work")
        #expect(http.count("catalogs/model") == 0) // Unsupported capabilities are not queried.
        model.updateNetwork(.init(availability: .offline))
        await model.refresh(connectors: [])
        #expect(!model.canCreate)
        #expect(model.runtimeID == "rti_work")
        #expect(model.draft.text == "保留这个任务")
        model.updateNetwork(.init(availability: .online))
        await model.refresh(connectors: try devices())
        #expect(model.canCreate)
        #expect(http.calls.allSatisfy { $0.method == .get })
    }

    @Test func latePreparationCannotReenableOfflineDevice() async throws {
        let http = transport(); let model = make(http)
        let gate = TestGate()
        http.respond = { call in
            if call.path.hasSuffix("capabilities") { await gate.wait() }
            if call.path.hasSuffix("/rti_work") { return try fixtureData("runtime") }
            return try http.defaultResponse(call)
        }
        let loading = Task { await model.refresh(connectors: try devices()) }
        try await eventually { http.count("capabilities") == 1 }
        await model.refresh(connectors: try devices(online: false))
        gate.release(); _ = await loading.result
        #expect(model.prepared == nil)
        #expect(!model.canCreate)
        #expect(model.connector?.status == .offline)
    }

    @Test func targetIsAtomicAndWorkspacePreferencesAreAccountScoped() async throws {
        let suite = "aa-tests-\(UUID().uuidString)"; let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = make(transport(), defaults: defaults)
        await model.refresh(connectors: try devices())
        #expect(await model.selectTarget(connectorID: "device", runtimeID: "rti_work"))
        model.setWorkspace("/work/repo")
        #expect(!(await model.selectTarget(connectorID: "another-device", runtimeID: "rti_work")))
        #expect(model.connectorID == "device" && model.runtimeID == "rti_work")
        #expect(model.workspace == "/work/repo")
        let restored = make(transport(), defaults: defaults)
        #expect(restored.connectorID == "device" && restored.runtimeID == "rti_work")
        #expect(restored.workspace == "/work/repo")
        let otherAccount = make(transport(), defaults: defaults, account: "two")
        #expect(otherAccount.connectorID.isEmpty && otherAccount.workspace.isEmpty)
    }

    @Test func creationRevalidatesRuntimeBeforeWriting() async throws {
        let http = transport(); let model = make(http)
        model.draft.text = "task"
        await model.refresh(connectors: try devices())
        #expect(model.canCreate)
        http.respond = { call in
            if call.path.hasSuffix("/rti_work") {
                var runtime = try fixtureObject("runtime"); runtime["status"] = "stopped"; runtime["active"] = false
                return try JSONSerialization.data(withJSONObject: runtime)
            }
            return try http.defaultResponse(call)
        }
        #expect(await model.create(text: "task") == nil)
        #expect(http.calls.allSatisfy { $0.method == .get })
        #expect(!model.creationUncertain)
        #expect(model.draft.text == "task")
    }

    @Test func uncertainCreationDoesNotReplayAfterReconnectAndKeepsConcurrentEdits() async throws {
        let http = transport(); let model = make(http)
        model.draft.text = "task"
        await model.refresh(connectors: try devices())
        http.respond = { call in
            if call.path.hasSuffix("/rti_work") { return try fixtureData("runtime") }
            if call.method == .post { model.draft.text = "next draft"; throw URLError(.timedOut) }
            return try http.defaultResponse(call)
        }
        #expect(await model.create(text: "task") == nil)
        #expect(model.creationUncertain)
        model.updateNetwork(.init(availability: .offline))
        model.updateNetwork(.init(availability: .online))
        await model.refresh(connectors: try devices())
        #expect(await model.create(text: "next draft") == nil)
        #expect(http.calls.filter { $0.method == .post }.count == 1)
        #expect(model.error != nil && model.draft.text == "next draft")
    }

    @Test func successfulCreateUsesTypeAndInstanceAndDoesNotPersistDraft() async throws {
        let http = transport(); let model = make(http)
        model.draft.text = "task\nsecond line"
        await model.refresh(connectors: try devices())
        model.setWorkspace("/work")
        let result = await model.create(text: model.draft.text)
        #expect(result != nil)
        let request = try #require(http.calls.first { $0.method == .post })
        #expect(request.body?["runtime"] == .string("claude"))
        #expect(request.body?["runtimeId"] == .string("rti_work"))
        #expect(request.body?["cwd"] == .string("/work"))
        #expect(request.body?["content"] == .string("task\nsecond line"))
        #expect(model.draft.text.isEmpty)
    }
}
