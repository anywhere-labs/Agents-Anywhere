import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct ProjectPresentationTests {
    private func project(_ id: String, name: String? = nil, device: String = "device", path: String = "/workspace",
                         manual: Bool = true, pinned: Bool = false, active: Int = 0, archived: Int = 0,
                         activity: String? = nil, created: String = "2026-01-01T00:00:00Z") -> V2Project {
        .init(id: id, userId: "account", connectorId: device, name: name ?? id, workspacePath: path,
              manuallyCreated: manual, pinned: pinned, pinnedAt: nil, activeSessionCount: active,
              sidebarSessionCounts: .init(active: active, archived: archived), lastActivityAt: activity,
              createdAt: created, updatedAt: created)
    }
    private func session(_ id: String, project: String?, device: String = "device", path: String = "/workspace", pinned: Bool = false,
                         archived: Bool = false, activity: String = "2026-03-01T00:00:00Z") throws -> V2SessionMeta {
        var value = try fixtureObject("session")["session"] as! [String: Any]
        value["id"] = id; value["connectorId"] = device; value["cwd"] = path
        value["projectId"] = project as Any? ?? NSNull(); value["pinned"] = pinned
        value["archived"] = archived; value["sortAt"] = activity
        return try decode(value)
    }
    @Test func manualEmptyProjectsLeadEachPartitionAndLoadedActivityUpdatesOrder() throws {
        let values = [
            project("ordinary-new", active: 1, activity: "2026-02-01T00:00:00Z"),
            project("ordinary-empty"),
            project("pinned-active", pinned: true, active: 1, activity: "2026-05-01T00:00:00Z"),
            project("pinned-empty", pinned: true),
            project("ordinary-recent", active: 1, activity: "2026-01-01T00:00:00Z"),
            project("archived-only", archived: 1, activity: "2026-01-01T00:00:00Z"),
            project("automatic-empty", manual: false),
        ]
        let loaded = [try session("live", project: "ordinary-recent", activity: "2026-06-01T00:00:00Z")]
        let order = ProjectSidebarPresentation.projects(values, filter: .active, sessions: loaded).map(\.id)
        #expect(order == ["pinned-empty", "pinned-active", "ordinary-empty", "ordinary-recent", "ordinary-new", "archived-only"])
        let firstSession = try session("first", project: "ordinary-empty", activity: "2026-04-01T00:00:00Z")
        #expect(ProjectSidebarPresentation.projects(values, filter: .active, sessions: loaded + [firstSession]).map(\.id)
                == ["pinned-empty", "pinned-active", "ordinary-recent", "ordinary-empty", "ordinary-new", "archived-only"])
    }
    @Test func incompleteProjectPagesAndEmptyFilteredViewsNeverMeanEmptyProject() throws {
        let unloaded = project("unloaded", active: 20, activity: "2026-04-01T00:00:00Z")
        let archived = project("archive", archived: 3, activity: "2026-05-01T00:00:00Z")
        let empty = project("empty")
        #expect(ProjectSidebarPresentation.projects([unloaded, archived, empty], filter: .active).map(\.id) == ["empty", "archive", "unloaded"])
        let autoArchived = project("auto-archive", manual: false, archived: 3, activity: "2026-05-01T00:00:00Z")
        #expect(!ProjectSidebarPresentation.visible(autoArchived, filter: .active))
        #expect(ProjectSidebarPresentation.visible(autoArchived, filter: .archived, sessions: [try session("archived", project: "auto-archive", archived: true)]))
    }
    @Test func sortingNormalizesTimezoneAndUsesStableCreatedNameAndIDTies() {
        let values = [project("z", name: "Same", active: 1, activity: "2026-01-01T08:00:00+08:00"),
                      project("a", name: "Same", active: 1, activity: "2026-01-01T00:00:00.000Z"),
                      project("newer", active: 1, activity: "2026-01-01T00:00:00Z", created: "2026-01-02T00:00:00Z")]
        #expect(ProjectSidebarPresentation.projects(values, filter: .all).map(\.id) == ["newer", "a", "z"])
    }
    @Test func flatModeIncludesProjectSessionsWithoutDuplicatingPinnedSessions() throws {
        let values = [try session("project", project: "project"), try session("legacy", project: nil),
                      try session("pinned", project: "project", pinned: true), try session("archived", project: "project", archived: true)]
        #expect(Set(ProjectSidebarPresentation.sessions(values, projectID: nil, filter: .active).map(\.id)) == ["project", "legacy"])
        #expect(ProjectSidebarPresentation.sessions(values, projectID: "project", filter: .active).map(\.id) == ["project"])
    }
    @Test func directoryChoicesUseBothSessionAndProjectPathsAndStayOnOneDevice() throws {
        let sessions = [try session("home", project: nil, path: "C:\\Users\\Me"),
                        try session("one", project: "project", path: "C:\\Code\\App"),
                        try session("duplicate", project: nil, path: "c:/code/app/"),
                        try session("other", project: nil, device: "other", path: "C:\\Private")]
        let values = [project("project", path: "c:/code/app"), project("only-project", path: "D:\\Work"),
                      project("other-project", device: "other", path: "D:\\Other")]
        let choices = WorkspaceDirectoryChoice.recent(connectorID: "device", deviceOS: "windows", home: "c:/users/me/", projects: values, sessions: sessions)
        #expect(choices.map(\.id) == ["c:/code/app", "d:/work"])
    }
    @Test func projectNameSuggestionsReuseWorkspaceAndDeduplicateAcrossDevices() {
        let draft = ProjectEditorDraft(connectorID: "device")
        let projects = [project("match", name: "Personal", path: "/home/me"),
                        project("other", name: "app", device: "other"), project("other2", name: "app (1)", device: "third")]
        draft.editPath("/home/me/./", projects: projects, deviceOS: "linux")
        #expect(draft.name == "Personal")
        draft.editPath("/code/app", projects: projects, deviceOS: "linux")
        #expect(draft.name == "app (2)")
        draft.editName("My custom name")
        draft.editPath("/other/path", projects: projects, deviceOS: "linux")
        draft.selectDevice("other")
        #expect(draft.path.isEmpty && draft.name == "My custom name")
        let edit = ProjectEditorDraft(project: projects[0])
        edit.selectDevice("other"); edit.editPath("/changed", projects: projects, deviceOS: "linux")
        #expect(edit.connectorID == "device" && edit.path == "/home/me")
    }
    @Test func rootNamesUnicodeLengthAndRemoteParentsDoNotUseIOSPaths() {
        #expect(ProjectWorkspacePath.name("C:\\") == "Workspace")
        #expect(ProjectWorkspacePath.name("\\\\server\\share\\") == "Workspace")
        #expect(ProjectWorkspacePath.parent("C:\\Code\\App") == "C:/Code")
        #expect(ProjectWorkspacePath.parent("\\\\server\\share\\App") == "//server/share")
        #expect(ProjectWorkspacePath.parent("C:\\") == "")
        let long = String(repeating: "😀", count: 255)
        let name = ProjectWorkspacePath.availableName(long, projects: [project("long", name: long)])
        #expect(name.unicodeScalars.count == 255 && name.hasSuffix(" (1)"))
    }
    @Test func expansionPreferencesRestoreByServerAndAccountIndependentlyOfMode() {
        let suite = "aa-sidebar-tests-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let scope = V2ClientScope(serverURL: URL(string: "https://example.test/")!, accountID: "one")
        let state = ProjectSidebarPreferences(scope: scope, defaults: defaults)
        #expect(state.projectsExpanded && state.expandedProjects.isEmpty && !defaults.bool(forKey: ProjectSidebarPreferences.sessionListKey))
        state.expandedProjects = ["p1", "p2"]; state.projectsExpanded = false
        defaults.set(true, forKey: ProjectSidebarPreferences.sessionListKey)
        defaults.set(false, forKey: ProjectSidebarPreferences.sessionListKey)
        let restored = ProjectSidebarPreferences(scope: scope, defaults: defaults)
        #expect(restored.expandedProjects == ["p1", "p2"] && !restored.projectsExpanded)
        let other = ProjectSidebarPreferences(scope: .init(serverURL: scope.serverURL, accountID: "two"), defaults: defaults)
        let otherServer = ProjectSidebarPreferences(scope: .init(serverURL: URL(string: "https://another.test")!, accountID: "one"), defaults: defaults)
        #expect(other.expandedProjects.isEmpty && otherServer.expandedProjects.isEmpty)
    }
    @Test func restoredExpansionUsesSharedInventoryWithoutReads() async throws {
        let http = TestHTTPTransport()
        let repository = V2DashboardRepository(service: .init(connectorAPI: V2ConnectorAPI(transport: http), projectAPI: .init(transport: http),
            sessionAPI: V2SessionAPI(transport: http), realtimeAPI: TestRealtimeAPI()))
        repository.sidebarPreferences.expandedProjects = ["project"]
        repository.apply(try fixture("dashboard"))
        for _ in 0..<3 {
            #expect(ProjectSidebarPresentation.sessions(repository.sessions, projectID: "project", filter: .active).count == 1)
            repository.apply(try fixture("dashboard"))
        }
        #expect(http.calls.isEmpty)

    }
}
