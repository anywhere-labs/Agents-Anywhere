import Foundation
import Observation

/// Editing a project is entirely local until the form's final submit action.
@MainActor @Observable final class ProjectEditorDraft {
    let original: V2Project?
    private(set) var connectorID: String
    private(set) var path: String
    private(set) var name: String
    private(set) var nameEdited = false
    @ObservationIgnored private let initialConnectorID: String

    init(project: V2Project? = nil, connectorID: String = "") {
        original = project
        self.connectorID = project?.connectorId ?? connectorID
        initialConnectorID = project?.connectorId ?? connectorID
        path = project?.workspacePath ?? ""
        name = project?.name ?? ""
    }

    var hasChanges: Bool {
        connectorID != initialConnectorID || path != (original?.workspacePath ?? "") || name != (original?.name ?? "")
    }

    func selectDevice(_ id: String) {
        guard original == nil, id != connectorID else { return }
        connectorID = id; path = ""
        if !nameEdited { name = "" }
    }
    func editName(_ value: String) { name = value; nameEdited = true }
    func editPath(_ value: String, projects: [V2Project], deviceOS: String?) {
        guard original == nil else { return }
        path = value
        suggestName(projects: projects, deviceOS: deviceOS)
    }
    func suggestName(projects: [V2Project], deviceOS: String?) {
        guard original == nil, !nameEdited else { return }
        guard !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { name = ""; return }
        if let existing = ProjectWorkspacePath.project(in: projects, connectorID: connectorID, path: path, deviceOS: deviceOS) {
            name = existing.name
        } else {
            name = ProjectWorkspacePath.availableName(ProjectWorkspacePath.name(path), projects: projects)
        }
    }
    func normalizeName(projects: [V2Project], deviceOS: String?) {
        let existing = original ?? ProjectWorkspacePath.project(in: projects, connectorID: connectorID, path: path, deviceOS: deviceOS)
        name = ProjectWorkspacePath.availableName(name, projects: projects, ignoring: existing?.id)
    }
}

struct WorkspaceDirectoryChoice: Identifiable, Equatable {
    let id: String
    let path: String
    var name: String { ProjectWorkspacePath.name(path) }

    static func recent(connectorID: String, deviceOS: String?, home: String?, projects: [V2Project], sessions: [V2SessionMeta]) -> [Self] {
        var seen = Set(home.flatMap { ProjectWorkspacePath.key($0, deviceOS: deviceOS) }.map { [$0] } ?? [])
        let paths = sessions.filter { $0.connectorId == connectorID }.compactMap(\.cwd)
            + projects.filter { $0.connectorId == connectorID }.map(\.workspacePath)
        return paths.compactMap { path in
            guard let key = ProjectWorkspacePath.key(path, deviceOS: deviceOS), seen.insert(key).inserted else { return nil }
            return Self(id: key, path: path)
        }
    }
}
