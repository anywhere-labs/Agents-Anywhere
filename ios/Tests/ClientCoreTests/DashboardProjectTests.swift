import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct DashboardProjectTests {
    private func repository(_ http: TestHTTPTransport) -> V2DashboardRepository {
        .init(service: .init(connectorAPI: V2ConnectorAPI(transport: http), projectAPI: .init(transport: http),
            sessionAPI: V2SessionAPI(transport: http), realtimeAPI: TestRealtimeAPI()))
    }
    private func dashboard(title: String = "new", cursor: String? = nil) throws -> V2DashboardSnapshot {
        var value = try fixtureObject("dashboard")
        var session = (value["sessions"] as! [[String: Any]])[0]
        session["title"] = title; session["updatedSeq"] = 20
        value["sessions"] = [session]
        value["sessionPages"] = ["active": ["hasMore": cursor != nil, "nextCursor": cursor as Any? ?? NSNull()],
                                 "archived": ["hasMore": false, "nextCursor": NSNull()]]
        return try decode(value)
    }
    @Test func lateHTTPRefreshCannotOverwriteAPush() async throws {
        let http = TestHTTPTransport(); let store = repository(http); let gate = TestGate()
        http.respond = { call in await gate.wait(); return try http.defaultResponse(call) }
        let refresh = Task { await store.refresh() }
        try await eventually { http.calls.count == 3 }
        store.apply(try dashboard(title: "updated remotely"))
        gate.release(); await refresh.value
        #expect(store.sessions.first?.title == "updated remotely")
        #expect(store.projects.count == 1 && store.hasLoaded && !store.isLoading)
    }

    @Test func offlineAndInvalidatedRepositoriesDoNotFetchOrEraseCachedData() async throws {
        let http = TestHTTPTransport(); let store = repository(http)
        store.apply(try dashboard(cursor: "100"))
        store.updateNetwork(.init(availability: .offline))
        await store.refresh()
        #expect(http.calls.isEmpty && store.projects.count == 1 && store.sessions.count == 1)
        store.invalidate(); store.apply(try dashboard())
        #expect(store.projects.isEmpty && store.sessions.isEmpty)
    }

    @Test func reusedWorkspaceRequiresConsentBeforeAnyWrite() async throws {
        let http = TestHTTPTransport(); let store = repository(http)
        store.apply(try dashboard())
        do {
            _ = try await store.createProject(name: "Renamed", connectorID: "device", path: "/workspace/./")
            Issue.record("Expected project reuse confirmation")
        } catch let conflict as ProjectReuseRequired { #expect(conflict.project.id == "project") }
        #expect(http.calls.allSatisfy { $0.method == .get })
        http.respond = { call in
            if call.method == .post { return try fixtureData("project") }
            return try http.defaultResponse(call)
        }
        _ = try await store.createProject(name: "Renamed", connectorID: "device", path: "/workspace", reusing: "project")
        #expect(http.calls.filter { $0.method == .post }.count == 1)
        #expect(http.calls.last(where: { $0.method == .post })?.body?["manuallyCreated"] == .bool(true))
    }

    @Test func theManualFormPromotesAnAutomaticProjectWithoutChangingItsWorkspace() async throws {
        let http = TestHTTPTransport()
        let repository = self.repository(http)
        repository.apply(try dashboard())
        var value = try fixtureObject("project")["project"] as! [String: Any]
        value["manuallyCreated"] = false
        let name = value["name"] as! String
        http.respond = { call in
            if call.method == .get { return try JSONSerialization.data(withJSONObject: ["projects": [value], "serverTime": ""]) }
            value["manuallyCreated"] = true
            return try JSONSerialization.data(withJSONObject: ["project": value, "serverTime": ""])
        }
        let project = try await repository.createProject(name: name, connectorID: "device", path: "/workspace/./")
        #expect(project.id == "project" && project.manuallyCreated && project.workspacePath == "/workspace")
        #expect(http.calls.last(where: { $0.method == .post })?.body?["workspacePath"] == .string("/workspace"))
        #expect(http.calls.last(where: { $0.method == .post })?.body?["name"] == .string(name))
        #expect(http.calls.last(where: { $0.method == .post })?.body?["manuallyCreated"] == .bool(true))
    }

    @Test func projectVisibilityUsesSharedSessionsAndArchiveStateOnly() throws {
        var value = try fixtureObject("project")["project"] as! [String: Any]
        value["manuallyCreated"] = false
        value["sidebarSessionCounts"] = ["active": 0, "archived": 3]
        var project: V2Project = try decode(value)
        #expect(!ProjectSidebarPresentation.visible(project, filter: .active))
        var archived = try fixtureObject("session")["session"] as! [String: Any]
        archived["archived"] = true
        #expect(ProjectSidebarPresentation.visible(project, filter: .archived, sessions: [try decode(archived)]))
        value["manuallyCreated"] = true; project = try decode(value)
        #expect(ProjectSidebarPresentation.visible(project, filter: .active))
        var session = try fixtureObject("session")["session"] as! [String: Any]
        session["sourceAvailability"] = "missing"; session["archived"] = false
        #expect(ProjectSidebarPresentation.sessions([try decode(session)], projectID: "project", filter: .active).count == 1)
        session["pinned"] = true
        #expect(ProjectSidebarPresentation.sessions([try decode(session)], projectID: "project", filter: .active).isEmpty)
    }

    @Test func remotePathComparisonDoesNotUseTheHostFilesystem() {
        #expect(ProjectWorkspacePath.key(" /a/../b/ ", deviceOS: "linux") == "/b")
        #expect(ProjectWorkspacePath.key("C:\\Code\\.\\App\\", deviceOS: "windows") == "c:/code/app")
        #expect(ProjectWorkspacePath.key("C:\\Code\\..\\App", deviceOS: "windows") == "c:/code/../app")
        #expect(ProjectWorkspacePath.key("//server/share/", deviceOS: "windows") == "//server/share")
        #expect(ProjectWorkspacePath.key("relative", deviceOS: "linux") == nil)
    }
}
