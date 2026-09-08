import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct DashboardInventoryTests {
    private func repository(_ http: TestHTTPTransport) -> V2DashboardRepository {
        .init(service: .init(connectorAPI: V2ConnectorAPI(transport: http), projectAPI: .init(transport: http),
            sessionAPI: V2SessionAPI(transport: http), realtimeAPI: TestRealtimeAPI()))
    }
    private func session(_ id: String, project: String? = "project", archived: Bool = false) throws -> V2SessionMeta {
        var value = try fixtureObject("session")["session"] as! [String: Any]
        value["id"] = id; value["projectId"] = project as Any? ?? NSNull(); value["archived"] = archived
        return try decode(value)
    }
    private func project(_ id: String = "project", name: String = "Project") throws -> V2Project {
        var value = try fixtureObject("project")["project"] as! [String: Any]
        value["id"] = id; value["name"] = name
        return try decode(value)
    }

    @Test func initialLoadReadsOneCompleteSessionInventoryForEveryProjectAndArchiveState() async throws {
        let http = TestHTTPTransport(); let store = repository(http)
        let sessions = try (0..<210).map { try session("s\($0)", archived: $0 >= 105) }
        http.respond = { call in
            if call.path == "/sessions/list" {
                return try JSONEncoder().encode(JSONValue.object([
                    "sessions": try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(sessions)),
                    "serverTime": .string("")]))
            }
            return try http.defaultResponse(call)
        }
        await store.refresh()
        #expect(Set(http.calls.map(\.path)) == ["/connectors", "/projects", "/sessions/list"])
        #expect(http.calls.count == 3 && http.calls.allSatisfy { $0.query.isEmpty })
        #expect(store.sessions.count == 210)
        #expect(ProjectSidebarPresentation.sessions(store.sessions, projectID: "project", filter: .active).count == 105)
        #expect(ProjectSidebarPresentation.sessions(store.sessions, projectID: "project", filter: .archived).count == 105)
        store.sidebarPreferences.expandedProjects = ["project"]
        #expect(http.calls.count == 3)
    }

    @Test func completePushRemovesDeletedSessionsButRetainsPendingLocalCreation() async throws {
        let store = repository(TestHTTPTransport())
        store.apply(try fixture("dashboard"))
        store.upsert([try session("local:pending")])
        var empty = try fixtureObject("dashboard"); empty["sessions"] = []
        store.apply(try decode(empty))
        #expect(store.sessions.map(\.id) == ["local:pending"])
    }

    @Test func missingProjectSessionsStayVisibleUntilTheProjectArrives() throws {
        let values = [try session("known"), try session("missing", project: "new-project"),
            try session("unassigned", project: nil), try session("archived", project: nil, archived: true)]
        let projects = [try project()]
        #expect(Set(ProjectSidebarPresentation.unassignedSessions(values, projects: projects, filter: .active).map(\.id))
            == ["missing", "unassigned"])
        #expect(ProjectSidebarPresentation.unassignedSessions(values, projects: projects, filter: .archived).map(\.id) == ["archived"])
        #expect(ProjectSidebarPresentation.unassignedSessions(values, projects: projects + [try project("new-project")], filter: .active).map(\.id) == ["unassigned"])
    }

    @Test func unknownProjectBindingsShareOneRefreshAndBecomeVisibleWhenItArrives() async throws {
        let http = TestHTTPTransport(); let store = repository(http); let gate = TestGate()
        store.apply(try fixture("dashboard"))
        let projects = [try project(), try project("new-project", name: "New Project")]
        http.respond = { _ in
            await gate.wait()
            return try JSONEncoder().encode(JSONValue.object([
                "projects": try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(projects)),
                "serverTime": .string("")]))
        }
        store.upsert([try session("a", project: "new-project"), try session("b", project: "new-project")])
        try await eventually { http.calls.count == 1 }
        gate.release()
        try await eventually { store.projects.count == 2 }
        #expect(http.calls.map(\.path) == ["/projects"])
        #expect(ProjectSidebarPresentation.sessions(store.sessions, projectID: "new-project", filter: .active).count == 2)
    }

    @Test func unassignedSessionsDoNotRefreshProjectsOnEachMessage() async throws {
        let http = TestHTTPTransport(); let store = repository(http)
        store.apply(try fixture("dashboard"))
        store.upsert([try session("unassigned", project: nil)])
        try await eventually { http.calls.count == 1 }
        await Task.yield()
        store.upsert([try session("unassigned", project: nil)])
        await Task.yield()
        #expect(http.calls.map(\.path) == ["/projects"])
    }

    @Test func projectRefreshCannotOverwriteNewerPushOrAnotherAccount() async throws {
        let http = TestHTTPTransport(); let store = repository(http); let gate = TestGate()
        store.apply(try fixture("dashboard"))
        http.respond = { call in await gate.wait(); return try http.defaultResponse(call) }
        let refresh = Task { await store.refreshProjects() }
        try await eventually { http.calls.count == 1 }
        var pushed = try fixtureObject("dashboard")
        var projects = pushed["projects"] as! [[String: Any]]
        projects[0]["name"] = "Newer name"; pushed["projects"] = projects
        store.apply(try decode(pushed))
        gate.release(); await refresh.value
        #expect(store.projects.first?.name == "Newer name")
        store.invalidate()
        await store.refreshProjects()
        #expect(store.projects.isEmpty && http.calls.count == 1)
    }

    @Test func failedProjectRefreshCanRecoverOnTheNextSessionUpdate() async throws {
        let http = TestHTTPTransport(); let store = repository(http)
        store.apply(try fixture("dashboard"))
        http.respond = { call in
            if http.calls.count == 1 { throw URLError(.networkConnectionLost) }
            return try http.defaultResponse(call)
        }
        store.upsert([try session("unassigned", project: nil)])
        try await eventually { store.error != nil }
        await Task.yield()
        store.upsert([try session("unassigned", project: nil)])
        try await eventually { http.calls.count == 2 }
        #expect(store.sessions.count == 2)
    }
}
