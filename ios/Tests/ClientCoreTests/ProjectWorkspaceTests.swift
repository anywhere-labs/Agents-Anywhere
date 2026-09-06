import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct ProjectWorkspaceTests {
    private func project(_ id: String = "project", device: String = "device", path: String = "/workspace", name: String = "Personal", manual: Bool = true) -> V2Project {
        .init(id: id, userId: "account", connectorId: device, name: name, workspacePath: path,
              manuallyCreated: manual, pinned: false, pinnedAt: nil, activeSessionCount: 0,
              sidebarSessionCounts: .init(active: 0, archived: 0), lastActivityAt: nil,
              createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z")
    }
    private func response(_ values: [V2Project], list: Bool = true) throws -> Data {
        let objects = try values.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) }
        return try JSONSerialization.data(withJSONObject: [list ? "projects" : "project": list ? objects : objects[0], "serverTime": ""])
    }
    private func directory(_ path: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["ok": true, "result": ["path": path, "entries": [], "targetType": "directory"]])
    }
    private func model(_ http: TestHTTPTransport, defaults: UserDefaults? = nil) -> NewSessionModel {
        let api = V2ConnectorAPI(transport: http)
        return .init(scope: .init(serverURL: URL(string: "https://example.test")!, accountID: "account"),
                     devices: .init(connectorAPI: api), preparation: .init(connectorAPI: api),
                     creation: .init(sessionAPI: V2SessionAPI(transport: http)), projectAPI: .init(transport: http),
                     defaults: defaults ?? UserDefaults(suiteName: "aa-workspace-tests-\(UUID())")!)
    }
    private func defaultResponse(_ http: TestHTTPTransport, _ call: TestHTTPTransport.Call) throws -> Data {
        if call.path.hasSuffix("/capabilities") {
            var value = try fixtureObject("capabilities")
            var set = value["capabilitySet"] as! [String: Any]
            var capabilities = set["capabilities"] as! [[String: Any]]
            var attachment = capabilities[0]; attachment["capabilityId"] = "runtime.attachment"
            capabilities.append(attachment); set["capabilities"] = capabilities; value["capabilitySet"] = set
            return try JSONSerialization.data(withJSONObject: value)
        }
        if call.path.hasSuffix("/rti_work") { return try fixtureData("runtime") }
        if call.path.hasSuffix("/create-and-start") { return try fixtureData("session") }
        return try http.defaultResponse(call)
    }
    private func devices() throws -> [V2Connector] { try fixture("connectors", as: V2ConnectorListResponse.self).connectors }
    private var conflict: HTTPError { .server(statusCode: 409, message: "name conflict", detail: .object(["code": .string("project_name_conflict")])) }

    @Test func loadedProjectsMatchRemoteWindowsPathsAndPreserveCustomNameAndFlag() async throws {
        let http = TestHTTPTransport()
        let resolver = V2WorkspaceProjectResolver(api: .init(transport: http))
        let existing = project(path: "C:\\Users\\Me", name: "Personal workspace")
        let found = try await resolver.resolve(projects: [project("other", device: "other", path: "C:\\Users\\Me"), existing],
            connectorID: "device", path: " c:/users/me/./ ", deviceOS: "windows")
        #expect(found == existing && found.manuallyCreated)
        #expect(http.calls.isEmpty)
    }

    @Test func refreshedProjectIsReusedBeforeAnyCreate() async throws {
        let http = TestHTTPTransport(), existing = project(name: "My renamed workspace")
        http.respond = { _ in try response([existing]) }
        let found = try await V2WorkspaceProjectResolver(api: .init(transport: http)).resolve(projects: [], connectorID: "device", path: "/workspace", deviceOS: "linux")
        #expect(found == existing)
        #expect(http.calls.count == 1 && http.calls[0].method == .get)
    }

    @Test func automaticProjectsUseGlobalUniqueNamesAndExplicitAutomaticFlag() async throws {
        let http = TestHTTPTransport()
        let others = [project("one", device: "other", name: "workspace"), project("two", device: "third", name: "workspace (1)")]
        http.respond = { call in try response(call.method == .get ? others : [project(manual: false)], list: call.method == .get) }
        _ = try await V2WorkspaceProjectResolver(api: .init(transport: http)).resolve(projects: [], connectorID: "device", path: "/workspace", deviceOS: "linux")
        let request = try #require(http.calls.last)
        #expect(request.body?["name"] == .string("workspace (2)"))
        #expect(request.body?["manuallyCreated"] == .bool(false))
        #expect(request.body?["connectorId"] == .string("device"))
        #expect(http.calls.count == 2)
    }

    @Test func nameConflictRefreshesAndReusesTheOtherClientsProject() async throws {
        let http = TestHTTPTransport(); var reads = 0
        let existing = project(name: "Chosen on Desktop")
        http.respond = { call in
            if call.method == .post { throw conflict }
            reads += 1
            return try response(reads == 1 ? [] : [existing])
        }
        let found = try await V2WorkspaceProjectResolver(api: .init(transport: http)).resolve(projects: [], connectorID: "device", path: "/workspace", deviceOS: "linux")
        #expect(found == existing && reads == 2)
        #expect(http.calls.filter { $0.method == .post }.count == 1)
    }

    @Test(arguments: [true, false]) func onlyExplicitNameConflictsRetryAndAtMostThreeCreates(nameConflict: Bool) async throws {
        let http = TestHTTPTransport(); var writes = 0
        http.respond = { call in
            if call.method == .post { writes += 1; throw nameConflict ? conflict : HTTPError.server(statusCode: 409, message: "another conflict") }
            return try response((0..<writes).map { project("other-\($0)", device: "other", name: $0 == 0 ? "workspace" : "workspace (\($0))") })
        }
        await #expect(throws: HTTPError.self) {
            try await V2WorkspaceProjectResolver(api: .init(transport: http)).resolve(projects: [], connectorID: "device", path: "/workspace", deviceOS: "linux")
        }
        #expect(writes == (nameConflict ? 3 : 1))
        if nameConflict { #expect(http.calls.last?.body?["name"] == .string("workspace (2)")) }
    }

    @Test func homeCanSendWithoutManualSelectionAndConcurrentSendsShareOneCreation() async throws {
        let http = TestHTTPTransport(), gate = TestGate(); let draft = model(http)
        defer { gate.release(); draft.invalidate() }
        http.respond = { call in
            if call.path == "/projects" {
                if call.method == .get { await gate.wait(); return try response([]) }
                return try response([project(path: "/workspace/", manual: false)], list: false)
            }
            return try defaultResponse(http, call)
        }
        draft.draft.text = "start"
        await draft.refresh(connectors: try devices())
        #expect(draft.workspace == "/workspace" && draft.projectID == nil && draft.canCreate)
        let first = Task { await draft.create(text: "start") }
        try await eventually { http.count("/projects") == 1 }
        #expect(await draft.create(text: "start") == nil)
        gate.release()
        #expect(await first.value != nil)
        let create = try #require(http.calls.first { $0.path.hasSuffix("create-and-start") })
        #expect(create.body?["projectId"] == .string("project"))
        #expect(create.body?["cwd"] == .string("/workspace/"), "Use the returned project path, including its spelling")
        #expect(http.calls.filter { $0.path == "/projects" && $0.method == .post }.count == 1)
        #expect(http.count("create-and-start") == 1)
    }

    @Test func invalidationDuringProjectLookupPreventsFurtherWrites() async throws {
        let http = TestHTTPTransport(), gate = TestGate(); let draft = model(http)
        defer { gate.release() }
        http.respond = { call in
            if call.path == "/projects" { await gate.wait(); return try response([]) }
            return try defaultResponse(http, call)
        }
        draft.draft.text = "task"; await draft.refresh(connectors: try devices())
        let send = Task { await draft.create(text: "task") }
        try await eventually { http.count("/projects") == 1 }
        draft.invalidate(); gate.release()
        #expect(await send.value == nil)
        #expect(http.calls.allSatisfy { $0.method == .get || $0.path.hasSuffix("fs/list") })
    }

    @Test func anUncertainProjectWritePreservesTextAndAttachmentsWithoutAutomaticReplay() async throws {
        let http = TestHTTPTransport(); let draft = model(http)
        http.respond = { call in
            if call.path == "/projects" {
                if call.method == .post { throw URLError(.timedOut) }
                return try response([])
            }
            return try defaultResponse(http, call)
        }
        draft.draft.text = "keep this"
        await draft.refresh(connectors: try devices())
        let file = ChatAttachment(name: "notes.md", data: Data("hello".utf8), mediaType: "text/markdown")
        draft.draft.attachments = [file]
        #expect(draft.canCreate)
        #expect(await draft.create(text: "keep this") == nil)
        #expect(draft.draft.text == "keep this" && draft.draft.attachments == [file] && draft.error != nil)
        draft.updateNetwork(.init(availability: .offline)); draft.updateNetwork(.init(availability: .online))
        await draft.refresh(connectors: try devices())
        #expect(http.calls.filter { $0.path == "/projects" && $0.method == .post }.count == 1)
        #expect(http.count("create-and-start") == 0)
    }

    @Test func lateHomeResponseCannotReplaceAnotherDevicesDirectoryOrAUserChoice() async throws {
        let http = TestHTTPTransport(), gate = TestGate(); let draft = model(http)
        defer { gate.release(); draft.invalidate() }
        let first = try devices()[0]
        var otherJSON = try fixtureObject("connector")["connector"] as! [String: Any]
        otherJSON["id"] = "other"; otherJSON["status"] = "online"
        let other: V2Connector = try decode(otherJSON)
        http.respond = { call in
            if call.path.hasSuffix("fs/list") {
                #expect(call.body?["root"] == .string("~") && call.body?["path"] == .string("."))
                if call.path.contains("/device/") { await gate.wait(); return try directory("/Users/First") }
                return try directory("/Users/Second")
            }
            return try defaultResponse(http, call)
        }
        let initial = Task { await draft.refresh(connectors: [first, other]) }
        try await eventually { http.count("fs/list") == 1 }
        draft.focusDevice("other", workspace: nil)
        #expect(draft.workspace.isEmpty)
        await draft.refresh(connectors: [first, other])
        #expect(draft.workspace == "/Users/Second")
        #expect(draft.selectWorkspace("/custom"))
        gate.release(); await initial.value
        #expect(draft.connectorID == "other" && draft.workspace == "/custom")
        draft.focusDevice("device", workspace: nil)
        await draft.refresh(connectors: [first, other])
        #expect(draft.workspace == "/Users/First")
        draft.focusDevice("other", workspace: nil)
        #expect(draft.workspace == "/custom")
    }

    @Test func lateProjectsAndRenamesIdentifyHomeWithoutChangingDraftOrWriting() async throws {
        let http = TestHTTPTransport(); let draft = model(http)
        http.respond = { call in try defaultResponse(http, call) }
        await draft.refresh(connectors: try devices())
        #expect(draft.isHome && draft.project == nil)
        draft.updateProjects([project(name: "Personal workspace")])
        #expect(draft.project?.name == "Personal workspace" && draft.isHome)
        draft.updateProjects([project(name: "Renamed")])
        #expect(draft.project?.name == "Renamed" && draft.workspace == "/workspace")
        draft.updateProjects([])
        #expect(draft.project == nil && draft.workspace == "/workspace")
        #expect(http.calls.allSatisfy { $0.method == .get || $0.path.hasSuffix("fs/list") })
    }

    @Test func remoteHomeFailureCanBeRetriedAndCachedDraftRestoresWithoutNetwork() async throws {
        let suite = "aa-home-tests-\(UUID())", http = TestHTTPTransport()
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let draft = model(http, defaults: defaults)
        http.respond = { call in
            if call.path.hasSuffix("fs/list") { throw URLError(.timedOut) }
            return try defaultResponse(http, call)
        }
        await draft.refresh(connectors: try devices())
        #expect(draft.workspace.isEmpty && draft.homeErrors["device"] != nil)
        http.respond = { call in try defaultResponse(http, call) }
        await draft.resolveHome()
        #expect(draft.workspace == "/workspace" && draft.isHome)
        let count = http.calls.count
        let restored = model(http, defaults: defaults)
        #expect(restored.workspace == "/workspace" && restored.isHome && http.calls.count == count)
    }
}
