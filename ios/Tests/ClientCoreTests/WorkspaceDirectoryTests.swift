import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct WorkspaceDirectoryTests {
    private func result(_ path: String, type: String = "directory") throws -> Data {
        try JSONSerialization.data(withJSONObject: ["ok": true, "result": ["path": path, "targetType": type,
            "entries": [["name": path, "path": path + "/file", "type": "file"]]]])
    }
    private func service(_ http: TestHTTPTransport) -> V2WorkspaceFilesService {
        .init(connectorAPI: V2ConnectorAPI(transport: http), serverURL: URL(string: "https://example.test")!)
    }
    @Test func latestDirectoryWinsEvenIfAnOlderRequestFinishesLast() async throws {
        let http = TestHTTPTransport(), gate = TestGate(), model = WorkspaceDirectoryModel()
        http.respond = { call in
            let path = try #require(call.body?["path"]?.stringValue)
            if path == "/first" { await gate.wait() }
            return try result(path)
        }
        let first = Task { await model.load(connectorId: "device", root: "~", path: "/first", service: service(http)) }
        defer { gate.release() }
        try await eventually { http.calls.count == 1 }
        #expect(model.isLoading && model.selectablePath == nil)
        await model.load(connectorId: "device", root: "~", path: "/second", service: service(http))
        #expect(model.selectablePath == "/second" && !model.isLoading)
        gate.release(); await first.value
        #expect(model.resolvedPath == "/second" && model.entries.first?.name == "/second" && model.selectablePath == "/second")
    }
    @Test(arguments: ["file", "missing", "other"]) func nonDirectoryTargetsCannotConfirmTheParentFallback(type: String) async throws {
        let http = TestHTTPTransport(), model = WorkspaceDirectoryModel()
        http.respond = { _ in try result("/existing-parent", type: type) }
        await model.load(connectorId: "device", root: "~", path: "/existing-parent/target", service: service(http))
        #expect(model.selectablePath == nil && model.resolvedPath == "/existing-parent")
    }
    @Test func refreshFailureRevokesThePreviousSuccessfulSelection() async throws {
        let http = TestHTTPTransport(), model = WorkspaceDirectoryModel(), gate = TestGate()
        http.respond = { _ in try result("/loaded") }
        await model.load(connectorId: "device", root: "~", path: "/loaded", service: service(http))
        http.respond = { _ in await gate.wait(); throw URLError(.timedOut) }
        let refresh = Task { await model.load(connectorId: "device", root: "~", path: "/failed", service: service(http)) }
        defer { gate.release() }
        try await eventually { model.isLoading }
        #expect(model.selectablePath == nil)
        gate.release(); await refresh.value
        #expect(!model.isLoading && model.selectablePath == nil && model.errorMessage != nil)
        #expect(model.resolvedPath == "/loaded", "Previously loaded entries remain readable, but cannot confirm a failed navigation")
    }
}
