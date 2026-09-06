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
    private func page(id: String, cursor: String? = nil) throws -> Data {
        var value = try fixtureObject("sessions")
        var session = (value["sessions"] as! [[String: Any]])[0]; session["id"] = id
        value["sessions"] = [session]; value["hasMore"] = cursor != nil; value["nextCursor"] = cursor as Any? ?? NSNull()
        return try JSONSerialization.data(withJSONObject: value)
    }

    @Test func lateHTTPRefreshCannotOverwriteAPush() async throws {
        let http = TestHTTPTransport(); let store = repository(http); let gate = TestGate()
        http.respond = { call in await gate.wait(); return try http.defaultResponse(call) }
        let refresh = Task { await store.refresh() }
        try await eventually { http.calls.count == 4 }
        store.apply(try dashboard(title: "updated remotely"))
        gate.release(); await refresh.value
        #expect(store.sessions.first?.title == "updated remotely")
        #expect(store.projects.count == 1 && store.hasLoaded && !store.isLoading)
    }

    @Test func pushKeepsOlderPagesAndTheirCursorAndProjectPagesStaySeparate() async throws {
        let http = TestHTTPTransport(); let store = repository(http)
        store.apply(try dashboard(cursor: "global:100"))
        http.respond = { call in
            if call.path.hasPrefix("/projects/") { return try page(id: "project-only", cursor: "project:100") }
            return try page(id: "older", cursor: "global:200")
        }
        await store.loadPage(.init())
        await store.loadPage(.init(projectID: "project"))
        store.apply(try dashboard(cursor: "global:new-first-page"))
        #expect(Set(store.sessions.map(\.id)) == ["session", "older", "project-only"])
        #expect(store.pages[.init()]?.nextCursor == "global:200")
        #expect(store.pages[.init(projectID: "project")]?.nextCursor == "project:100")
        #expect(http.calls[0].query.contains(.init(name: "cursor", value: "global:100")))
        #expect(!http.calls[1].query.contains { $0.name == "cursor" })
    }

    @Test func projectMembershipSurvivesLeavingGlobalFirstPage() async throws {
        let http = TestHTTPTransport(); let store = repository(http)
        store.apply(try dashboard())
        http.respond = { _ in try page(id: "session") }
        await store.loadPage(.init(projectID: "project"))
        var next = try fixtureObject("dashboard"); next["sessions"] = []
        store.apply(try decode(next))
        #expect(store.sessions.map(\.id) == ["session"])
    }

    @Test func oldPageCannotUndoAnArchiveAndCanBeRetriedAfterSnapshot() async throws {
        let http = TestHTTPTransport(); let store = repository(http); let gate = TestGate()
        store.apply(try dashboard(cursor: "100"))
        http.respond = { _ in await gate.wait(); return try page(id: "session", cursor: "200") }
        let page = Task { await store.loadPage(.init()) }
        try await eventually { http.calls.count == 1 }
        var archived = try fixtureObject("session")["session"] as! [String: Any]
        archived["archived"] = true; archived["updatedSeq"] = 30
        store.upsert([try decode(archived, as: V2SessionMeta.self)])
        gate.release(); await page.value
        #expect(store.sessions.first?.archived == true)
        #expect(store.pages[.init()]?.nextCursor == "100")
        #expect(store.loadingPages.isEmpty)
    }

    @Test func offlineAndInvalidatedRepositoriesDoNotFetchOrEraseCachedData() async throws {
        let http = TestHTTPTransport(); let store = repository(http)
        store.apply(try dashboard(cursor: "100"))
        store.updateNetwork(.init(availability: .offline))
        await store.refresh(); await store.loadPage(.init())
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
    }

    @Test func projectVisibilityUsesServerCountsAndArchiveStateOnly() throws {
        var value = try fixtureObject("project")["project"] as! [String: Any]
        value["manuallyCreated"] = false
        value["sidebarSessionCounts"] = ["active": 0, "archived": 3]
        var project: V2Project = try decode(value)
        #expect(!ProjectSidebarPresentation.visible(project, filter: .active))
        #expect(ProjectSidebarPresentation.visible(project, filter: .archived))
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
