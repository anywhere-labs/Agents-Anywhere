import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct DeviceAgentTests {
    @Test func failedCreateRecoversPersistedInstanceInsteadOfCreatingAgain() async throws {
        let http = TestHTTPTransport()
        let type = try fixture("runtimeTypes", as: V2RuntimeTypeListResponse.self).runtimeTypes[0]
        var exists = false
        http.respond = { call in
            if call.path.hasSuffix("/runtimes"), call.method == .post {
                exists = true; throw URLError(.timedOut)
            }
            if call.path.hasSuffix("/runtimes"), call.method == .get {
                var value = try fixtureObject("runtimes")
                var item = try fixtureObject("runtime")
                item["runtimeType"] = type.runtimeType; item["name"] = "Work"
                item["configured"] = true; item["active"] = false; item["status"] = "stopped"
                value["runtimes"] = exists ? [item] : []
                return try JSONSerialization.data(withJSONObject: value)
            }
            if call.path.hasSuffix("/active") { return try fixtureData("runtime") }
            return try http.defaultResponse(call)
        }
        let model = DeviceAgentModel(connectorID: "device", service: .init(connectorAPI: V2ConnectorAPI(transport: http)))
        model.updateConnection(true)
        await #expect(throws: URLError.self) { try await model.add(type, name: "Work", config: [:], newInstance: true) }
        #expect(model.inventory.instances.count == 1)
        try await model.add(type, name: "Work", config: [:], newInstance: true)
        #expect(http.calls.filter { $0.path.hasSuffix("/runtimes") && $0.method == .post }.count == 1)
        #expect(http.count("/active") == 1)
    }

    @Test func disconnectDiscardsAnInFlightInventoryRead() async throws {
        let http = TestHTTPTransport(); let gate = TestGate()
        http.respond = { call in await gate.wait(); return try http.defaultResponse(call) }
        let model = DeviceAgentModel(connectorID: "device", service: .init(connectorAPI: V2ConnectorAPI(transport: http)))
        model.updateConnection(true)
        let read = Task { await model.refresh() }
        try await eventually { http.calls.count == 1 }
        model.updateConnection(false); gate.release(); await read.value
        #expect(model.inventory.instances.isEmpty && !model.isLoading && !model.connected)
    }

    @Test func pairingQueueSurvivesSheetCloseButNotAccountReset() async throws {
        let http = TestHTTPTransport(); let gate = TestGate()
        let connector = try fixture("connectors", as: V2ConnectorListResponse.self).connectors[0]
        var value = try fixtureObject("connectors")["connectors"] as! [[String: Any]]
        value[0]["status"] = "offline"
        let offline: V2Connector = try decode(value[0])
        http.respond = { _ in
            await gate.wait()
            return try JSONSerialization.data(withJSONObject: ["connector": value[0], "serverTime": ""])
        }
        let queue = AgentSetupCoordinator(service: .init(connectorAPI: V2ConnectorAPI(transport: http)))
        queue.pairingFormPresented = true; queue.watch(offline)
        try await eventually { http.calls.count == 1 }
        queue.pairingFormPresented = false
        queue.updateConnectors([connector])
        #expect(queue.presentedConnector == nil, "Connecting never opts into Agent configuration")
        queue.configure(connector.id)
        #expect(queue.presentedConnector?.id == connector.id)
        queue.invalidate(); gate.release()
        await Task.yield()
        #expect(queue.requests.isEmpty && queue.presentedConnector == nil)
    }

    @Test func shellCommandsQuoteUntrustedValues() {
        let url = URL(string: "https://example.test/it's")!
        #expect(V2PairingCommand.pair(server: url).contains("'\"'\"'"))
    }
}
