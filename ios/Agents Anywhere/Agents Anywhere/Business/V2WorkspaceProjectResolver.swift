import Foundation

/// Resolves both directory-mode and project-mode drafts through the existing
/// project API. Selecting a directory never calls this write boundary.
struct V2WorkspaceProjectResolver {
    let api: V2ProjectAPI

    func resolve(projects: [V2Project], connectorID: String, path: String, deviceOS: String?, validate: () throws -> Void = {}) async throws -> V2Project {
        try validate()
        guard !connectorID.isEmpty, ProjectWorkspacePath.key(path, deviceOS: deviceOS) != nil else {
            throw V2BusinessError.workspaceFilesUnavailable(message: String(localized: "请输入设备上的完整绝对路径。"))
        }
        if let existing = ProjectWorkspacePath.project(in: projects, connectorID: connectorID, path: path, deviceOS: deviceOS) {
            return existing
        }
        var current = try await api.list().projects
        for attempt in 0..<3 {
            try Task.checkCancellation()
            try validate()
            if let existing = ProjectWorkspacePath.project(in: current, connectorID: connectorID, path: path, deviceOS: deviceOS) {
                return existing
            }
            do {
                return try await api.create(.init(
                    name: ProjectWorkspacePath.availableName(ProjectWorkspacePath.name(path), projects: current),
                    connectorId: connectorID, workspacePath: path.trimmingCharacters(in: .whitespacesAndNewlines),
                    manuallyCreated: false
                )).project
            } catch {
                guard attempt < 2, let response = error as? HTTPError,
                      response.statusCode == 409, response.serverCode == "project_name_conflict" else { throw error }
                current = try await api.list().projects
            }
        }
        throw HTTPError.invalidResponse
    }
}
