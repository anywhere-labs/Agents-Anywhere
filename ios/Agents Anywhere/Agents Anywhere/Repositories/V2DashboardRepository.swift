import Foundation
import Observation

/// Account-scoped list cache. HTTP, push and explicit mutations share a revision
/// fence, so a late read cannot replace a newer snapshot or user action.
@MainActor @Observable
final class V2DashboardRepository {
    let sidebarPreferences: ProjectSidebarPreferences
    private(set) var connectors: [V2Connector] = []
    private(set) var projects: [V2Project] = []
    private(set) var sessions: [V2SessionMeta] = []
    private(set) var isLoading = false
    private(set) var hasLoaded = false
    private(set) var isFresh = false
    private(set) var error: String?
    private(set) var network = V2NetworkStatus()
    @ObservationIgnored var onChange: (() -> Void)?
    @ObservationIgnored var reconcile: (V2SessionMeta) -> V2SessionMeta = { $0 }
    @ObservationIgnored private let localStore: V2LocalStore?
    @ObservationIgnored private var persistenceTask: Task<Void, Never>?
    @ObservationIgnored private let service: V2DashboardService
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var isValid = true
    @ObservationIgnored private var projectGeneration = 0
    @ObservationIgnored private var projectRefreshTask: Task<Bool, Never>?
    @ObservationIgnored private var projectRefreshID: UUID?
    @ObservationIgnored private var projectRefreshGeneration: Int?
    @ObservationIgnored private var checkedMissingProjects: Set<String> = []

    init(service: V2DashboardService, localStore: V2LocalStore? = nil, scope: V2ClientScope? = nil, defaults: UserDefaults = .standard) {
        self.service = service; self.localStore = localStore
        sidebarPreferences = ProjectSidebarPreferences(scope: scope, defaults: defaults)
    }
    func restoreCache() async {
        guard let localStore, let value = await localStore.dashboard(), isValid, !hasLoaded else { return }
        connectors = value.connectors; projects = value.projects; sessions = value.sessions.map(reconcile)
        hasLoaded = true; isFresh = false; onChange?()
    }
    func flushCache() async {
        persistenceTask?.cancel(); persistenceTask = nil
        guard isValid, hasLoaded, let localStore else { return }
        await localStore.saveDashboard(.init(connectors: connectors, projects: projects, sessions: sessions,
            pages: []))
    }
    private func changed() {
        onChange?()
        guard isValid, hasLoaded, localStore != nil, persistenceTask == nil else { return }
        persistenceTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
            await self?.flushCache()
        }
    }
    var canWrite: Bool { isValid && isFresh && network.availability != .offline }
    func updateNetwork(_ network: V2NetworkStatus) { self.network = network }

    func refresh() async {
        guard isValid, network.availability != .offline, !isLoading else { return }
        generation += 1
        let revision = generation
        isLoading = true; error = nil; changed()
        defer { isLoading = false; changed() }
        do {
            let data = try await service.load()
            guard isValid, revision == generation, !Task.isCancelled else { return }
            apply(connectors: data.connectors, projects: data.projects, sessions: data.sessions)
        } catch {
            if isValid, revision == generation, !Task.isCancelled { self.error = error.localizedDescription }
        }
    }

    func apply(_ snapshot: V2DashboardSnapshot) {
        guard isValid, snapshot.type == "dashboard.snapshot" else { return }
        apply(connectors: snapshot.connectors, projects: snapshot.projects, sessions: snapshot.sessions)
    }

    private func apply(connectors: [V2Connector], projects: [V2Project], sessions incoming: [V2SessionMeta]) {
        generation += 1; projectGeneration += 1
        self.connectors = connectors
        self.projects = projects
        let current = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
        let validDevices = Set(connectors.map(\.id))
        let pending = sessions.filter { $0.id.hasPrefix("local:") && validDevices.contains($0.connectorId) }
        self.sessions = unique(pending + incoming.map { merge(current[$0.id], $0) })
        hasLoaded = true; isFresh = true; error = nil
        changed(); refreshMissingProjects()
    }

    /// The project list is shared by all expanded groups and refreshed independently
    /// from sessions when a mutation or an unknown binding requires it.
    @discardableResult func refreshProjects() async -> Bool {
        guard isValid, network.availability != .offline else { return false }
        if let task = projectRefreshTask, projectRefreshGeneration == projectGeneration { return await task.value }
        let revision = projectGeneration
        let requestID = UUID()
        let task = Task { [weak self] () -> Bool in
            guard let self else { return false }
            do {
                let response = try await service.projectAPI.list()
                guard isValid, projectGeneration == revision, !Task.isCancelled else { return false }
                generation += 1
                projects = response.projects; error = nil; changed()
                return true
            } catch {
                if isValid, projectGeneration == revision, !Task.isCancelled { self.error = error.localizedDescription }
                return false
            }
        }
        projectRefreshTask = task; projectRefreshID = requestID; projectRefreshGeneration = revision
        let refreshed = await task.value
        if projectRefreshID == requestID { projectRefreshTask = nil; projectRefreshID = nil; projectRefreshGeneration = nil }
        return refreshed
    }

    private func refreshMissingProjects() {
        guard isValid, isFresh, network.availability != .offline else { return }
        let projectIDs = Set(projects.map(\.id))
        let missingBindings = Set(sessions.compactMap { session -> String? in
            if session.id.hasPrefix("local:") { return nil }
            if let id = session.projectId { return projectIDs.contains(id) ? nil : "project:\(id)" }
            return "session:\(session.id)"
        })
        checkedMissingProjects.formIntersection(missingBindings)
        let missing = missingBindings.subtracting(checkedMissingProjects)
        guard !missing.isEmpty else { return }
        checkedMissingProjects.formUnion(missing)
        Task { [weak self] in
            guard let self else { return }
            if !(await refreshProjects()), isValid { checkedMissingProjects.subtract(missing) }
        }
    }

    func upsert(_ values: [V2SessionMeta]) {
        guard isValid else { return }
        generation += 1; mergeSessions(values); changed(); refreshMissingProjects()
    }
    func removeLocalSession(_ id: String) {
        guard id.hasPrefix("local:") else { return }
        sessions.removeAll { $0.id == id }; changed()
    }

    func upsertConnector(_ connector: V2Connector) {
        guard isValid else { return }
        generation += 1
        connectors.removeAll { $0.id == connector.id }; connectors.append(connector)
        changed()
    }
    func removeConnector(_ id: String) {
        guard isValid else { return }
        generation += 1; projectGeneration += 1
        connectors.removeAll { $0.id == id }; projects.removeAll { $0.connectorId == id }
        sessions.removeAll { $0.connectorId == id }; changed()
    }

    func createProject(name: String, connectorID: String, path: String, reusing projectID: String? = nil) async throws -> V2Project {
        try requireWritable()
        guard connectors.contains(where: { $0.id == connectorID && $0.status == .online }) else { throw URLError(.notConnectedToInternet) }
        let latest = try await service.projectAPI.list()
        try requireWritable()
        guard connectors.contains(where: { $0.id == connectorID && $0.status == .online }) else { throw URLError(.notConnectedToInternet) }
        projects = latest.projects; changed()
        let os = connectors.first { $0.id == connectorID }?.deviceOs
        guard let key = ProjectWorkspacePath.key(path, deviceOS: os) else {
            throw V2BusinessError.workspaceFilesUnavailable(message: String(localized: "请输入设备上的完整绝对路径。"))
        }
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let existing = latest.projects.first { $0.connectorId == connectorID && ProjectWorkspacePath.key($0.workspacePath, deviceOS: os) == key }
        if let existing, existing.name != name, existing.id != projectID {
            throw ProjectReuseRequired(project: existing)
        }
        // The manual form uses the server's workspace upsert, including when an
        // automatic project already owns the directory. It must become manual.
        let response = try await service.projectAPI.create(.init(name: ProjectWorkspacePath.availableName(name, projects: latest.projects, ignoring: existing?.id),
            connectorId: connectorID, workspacePath: existing?.workspacePath ?? path.trimmingCharacters(in: .whitespacesAndNewlines),
            manuallyCreated: true))
        try requireValid()
        upsertProject(response.project)
        await refreshProjects()
        return response.project
    }
    func updateProject(_ id: String, name: String? = nil, pinned: Bool? = nil) async throws {
        try requireWritable()
        let response = try await service.projectAPI.update(id, .init(name: name, pinned: pinned))
        try requireValid(); upsertProject(response.project)
        await refreshProjects()
    }
    func deleteProject(_ id: String) async throws {
        try requireWritable()
        try await service.projectAPI.delete(id)
        try requireValid()
        generation += 1; projectGeneration += 1; projects.removeAll { $0.id == id }
        for index in sessions.indices where sessions[index].projectId == id { sessions[index].projectId = nil }
        changed(); await refreshProjects()
    }
    func archiveProject(_ id: String, archived: Bool) async throws {
        try requireWritable()
        let response = try await service.projectAPI.archiveSessions(id, archived: archived)
        try requireValid(); upsert(response.sessions)
        // Counts and manuallyCreated are server-owned and can change on archive-all.
        await refreshProjects()
    }

    func invalidate() {
        persistenceTask?.cancel(); persistenceTask = nil
        isValid = false; generation += 1; onChange = nil
        projectRefreshTask?.cancel(); projectRefreshTask = nil; projectRefreshID = nil
        checkedMissingProjects = []
        sessions = []; connectors = []; projects = []
    }
    func upsertProject(_ project: V2Project) {
        guard isValid else { return }
        if let old = projects.first(where: { $0.id == project.id }), old.updatedAt > project.updatedAt { return }
        generation += 1; projectGeneration += 1
        projects.removeAll { $0.id == project.id }; projects.append(project); changed()
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
