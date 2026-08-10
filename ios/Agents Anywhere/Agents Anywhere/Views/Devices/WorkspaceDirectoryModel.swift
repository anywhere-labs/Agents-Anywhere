import Foundation
import Observation

@MainActor
@Observable
final class WorkspaceDirectoryModel {
    private(set) var entries: [V2WorkspaceEntry] = []
    private(set) var resolvedPath = ""
    private(set) var isLoading = false
    private(set) var isTruncated = false
    var errorMessage: String?

    /// Reads and sorts a directory through the workspace-files business service.
    func load(
        connectorId: V2ConnectorID,
        root: String,
        path: String,
        service: V2WorkspaceFilesService
    ) async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let directory = try await service.directory(
                connectorId: connectorId,
                root: root,
                path: path
            )
            resolvedPath = directory.path
            isTruncated = directory.truncated == true
            entries = directory.entries.sorted(by: workspaceEntryAscending)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func workspaceEntryAscending(
        _ left: V2WorkspaceEntry,
        _ right: V2WorkspaceEntry
    ) -> Bool {
        if left.isDirectory != right.isDirectory {
            return left.isDirectory
        }
        return left.name.localizedStandardCompare(right.name) == .orderedAscending
    }
}
