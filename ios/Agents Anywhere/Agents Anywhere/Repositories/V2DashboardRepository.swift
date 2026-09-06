import Foundation
import Observation

/// Account-scoped list cache. HTTP, push and explicit mutations share a revision
/// fence, so a late read cannot replace a newer snapshot or user action.
@MainActor @Observable
final class V2DashboardRepository {
    private(set) var connectors: [V2Connector] = []
    private(set) var projects: [V2Project] = []
    private(set) var sessions: [V2SessionMeta] = []
    private(set) var pages: [V2SessionListScope: V2SessionPageInfo] = [:]
    private(set) var loadingPages: Set<V2SessionListScope> = []
    private(set) var pageErrors: [V2SessionListScope: String] = [:]
    private(set) var isLoading = false
    private(set) var hasLoaded = false
    private(set) var error: String?
    private(set) var network = V2NetworkStatus()
    @ObservationIgnored var onChange: (() -> Void)?
    @ObservationIgnored var reconcile: (V2SessionMeta) -> V2SessionMeta = { $0 }
    @ObservationIgnored private let service: V2DashboardService
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var isValid = true
    @ObservationIgnored private var firstPageIDs: Set<String> = []
    @ObservationIgnored private var projectPageIDs: [V2SessionListScope: Set<String>] = [:]
    @ObservationIgnored private var extendedScopes: Set<V2SessionListScope> = []

    init(service: V2DashboardService) { self.service = service }
    var canWrite: Bool { isValid && network.availability != .offline }
    func updateNetwork(_ network: V2NetworkStatus) { self.network = network }

    func refresh() async {
        guard canWrite, !isLoading else { return }
        generation += 1
        let revision = generation
        isLoading = true; error = nil; onChange?()
        defer { isLoading = false; onChange?() }
        do {
            let data = try await service.load()
            guard isValid, revision == generation, !Task.isCancelled else { return }
            apply(connectors: data.connectors, projects: data.projects, sessions: data.sessions,
                active: .init(hasMore: data.active.hasMore, nextCursor: data.active.nextCursor),
                archived: .init(hasMore: data.archived.hasMore, nextCursor: data.archived.nextCursor))
        } catch {
            if isValid, revision == generation, !Task.isCancelled { self.error = error.localizedDescription }
        }
    }

    func apply(_ snapshot: V2DashboardSnapshot) {
        guard isValid, snapshot.type == "dashboard.snapshot" else { return }
        apply(connectors: snapshot.connectors, projects: snapshot.projects, sessions: snapshot.sessions,
            active: snapshot.sessionPages.active, archived: snapshot.sessionPages.archived)
    }

    private func apply(connectors: [V2Connector], projects: [V2Project], sessions incoming: [V2SessionMeta],
                       active: V2SessionPageInfo, archived: V2SessionPageInfo) {
        generation += 1
        self.connectors = connectors
        self.projects = projects
        let validDevices = Set(connectors.map(\.id))
        // Only replace the global first page. Expanded project pages and older
        // global pages remain cached until an authoritative update replaces them.
        let projectMembers = projectPageIDs.values.reduce(into: Set<String>()) { $0.formUnion($1) }
        var retained = sessions.filter { (!firstPageIDs.contains($0.id) || projectMembers.contains($0.id)) && validDevices.contains($0.connectorId) }
        let current = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
        retained.append(contentsOf: incoming.map { merge(current[$0.id], $0) })
        self.sessions = unique(retained)
        firstPageIDs = Set(incoming.map(\.id))
        for (scope, page) in [(V2SessionListScope(), active), (V2SessionListScope(archived: true), archived)] {
            if !extendedScopes.contains(scope) { pages[scope] = page }
        }
        let projectIDs = Set(projects.map(\.id))
        pages = pages.filter { $0.key.projectID.map(projectIDs.contains) ?? true }
        projectPageIDs = projectPageIDs.filter { $0.key.projectID.map(projectIDs.contains) ?? false }
        hasLoaded = true; error = nil
        onChange?()
    }

    func loadPage(_ scope: V2SessionListScope, refresh: Bool = false) async {
        guard canWrite, !loadingPages.contains(scope),
              scope.projectID == nil || projects.contains(where: { $0.id == scope.projectID }) else { return }
        let known = pages[scope]
        if !refresh, let known, !known.hasMore { return }
        let cursor = refresh ? nil : known?.nextCursor
        let revision = generation
        loadingPages.insert(scope); pageErrors[scope] = nil
        defer { loadingPages.remove(scope) }
        do {
            let response: V2SessionListResponse
            if let project = scope.projectID {
                response = try await service.projectAPI.sessions(project, archived: scope.archived, cursor: cursor)
            } else {
                response = try await service.sessionAPI.listSessions(archived: scope.archived, cursor: cursor)
            }
            guard isValid, revision == generation, !Task.isCancelled else { return }
            // Detect broken/repeated cursors rather than issuing the same page forever.
            let next = response.nextCursor
            pages[scope] = .init(hasMore: response.hasMore && next != nil && next != cursor, nextCursor: next)
            if cursor != nil { extendedScopes.insert(scope) }
            if scope.projectID != nil {
                if refresh { projectPageIDs[scope] = [] }
                projectPageIDs[scope, default: []].formUnion(response.sessions.map(\.id))
            }
            mergeSessions(response.sessions)
            onChange?()
        } catch {
            if isValid, revision == generation, !Task.isCancelled { pageErrors[scope] = error.localizedDescription }
        }
    }

    func upsert(_ values: [V2SessionMeta]) {
        guard isValid else { return }
        generation += 1; mergeSessions(values); onChange?()
    }
    func upsertConnector(_ connector: V2Connector) {
        generation += 1
        connectors.removeAll { $0.id == connector.id }; connectors.append(connector)
        onChange?()
    }
    func removeConnector(_ id: String) {
        generation += 1
        connectors.removeAll { $0.id == id }; projects.removeAll { $0.connectorId == id }
        sessions.removeAll { $0.connectorId == id }; onChange?()
    }

    func createProject(name: String, connectorID: String, path: String, reusing projectID: String? = nil) async throws -> V2Project {
        try requireWritable()
        let latest = try await service.projectAPI.list()
        try requireWritable()
        let os = connectors.first { $0.id == connectorID }?.deviceOs
        guard let key = ProjectWorkspacePath.key(path, deviceOS: os) else {
            throw V2BusinessError.workspaceFilesUnavailable(message: "请输入设备上的完整绝对路径。")
        }
        if let existing = latest.projects.first(where: { $0.connectorId == connectorID && ProjectWorkspacePath.key($0.workspacePath, deviceOS: os) == key }), existing.id != projectID {
            throw ProjectReuseRequired(project: existing)
        }
        let response = try await service.projectAPI.create(.init(name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            connectorId: connectorID, workspacePath: path.trimmingCharacters(in: .whitespacesAndNewlines)))
        try requireValid()
        upsertProject(response.project)
        return response.project
    }
    func updateProject(_ id: String, name: String? = nil, pinned: Bool? = nil) async throws {
        try requireWritable()
        let response = try await service.projectAPI.update(id, .init(name: name, pinned: pinned))
        try requireValid(); upsertProject(response.project)
    }
    func deleteProject(_ id: String) async throws {
        try requireWritable()
        try await service.projectAPI.delete(id)
        try requireValid()
        generation += 1; projects.removeAll { $0.id == id }
        pages = pages.filter { $0.key.projectID != id }; onChange?()
    }
    func archiveProject(_ id: String, archived: Bool) async throws {
        try requireWritable()
        let response = try await service.projectAPI.archiveSessions(id, archived: archived)
        try requireValid(); upsert(response.sessions)
        // Counts and manuallyCreated are server-owned and can change on archive-all.
        await refresh()
    }

    func invalidate() {
        isValid = false; generation += 1; onChange = nil
        sessions = []; connectors = []; projects = []; pages = [:]
        loadingPages = []; pageErrors = [:]
    }
    private func upsertProject(_ project: V2Project) {
        if let old = projects.first(where: { $0.id == project.id }), old.updatedAt > project.updatedAt { return }
        generation += 1
        projects.removeAll { $0.id == project.id }; projects.append(project); onChange?()
    }
    private func mergeSessions(_ incoming: [V2SessionMeta]) {
        var values = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
        for value in incoming { values[value.id] = merge(values[value.id], value) }
        sessions = Array(values.values).sorted { $0.id < $1.id }
    }
    private func merge(_ current: V2SessionMeta?, _ incoming: V2SessionMeta) -> V2SessionMeta {
        var value = current.map { $0.updatedSeq > incoming.updatedSeq ? $0 : incoming } ?? incoming
        value.lastReadSeq = max(current?.lastReadSeq ?? 0, incoming.lastReadSeq)
        if value.lastReadSeq >= value.latestTurnEndSeq { value.unread = false }
        return reconcile(value)
    }
    private func unique(_ values: [V2SessionMeta]) -> [V2SessionMeta] {
        var result: [String: V2SessionMeta] = [:]
        for value in values { result[value.id] = value }
        return Array(result.values).sorted { $0.id < $1.id }
    }
    private func requireValid() throws { if !isValid || Task.isCancelled { throw CancellationError() } }
    private func requireWritable() throws {
        try requireValid()
        if network.availability == .offline { throw URLError(.notConnectedToInternet) }
    }
}
