import Foundation
import Observation

@MainActor
@Observable
final class WorkspaceDirectoryModel {
    private(set) var entries: [V2WorkspaceEntry] = []
    private(set) var resolvedPath = ""
    private(set) var isLoading = false
    private(set) var isTruncated = false
    private(set) var selectablePath: String?
    @ObservationIgnored private var revision = 0
    var errorMessage: String?

    /// Reads and sorts a directory through the workspace-files business service.
    func load(
        connectorId: V2ConnectorID,
        root: String,
        path: String,
        service: V2WorkspaceFilesService
    ) async {
        revision += 1
        let request = revision
        isLoading = true
        selectablePath = nil
        errorMessage = nil
        defer { if request == revision { isLoading = false } }

        do {
            let directory = try await service.directory(
                connectorId: connectorId,
                root: root,
                path: path
            )
            try Task.checkCancellation()
            guard request == revision else { return }
            resolvedPath = directory.path
            isTruncated = directory.truncated == true
            entries = directory.entries.sorted(by: workspaceEntryAscending)
            if (directory.targetType == nil || directory.targetType == "directory"),
               ProjectWorkspacePath.key(directory.path, deviceOS: nil) != nil {
                selectablePath = directory.path
            }
        } catch {
            if request == revision, !Task.isCancelled { errorMessage = error.localizedDescription }
        }
    }

    private func workspaceEntryAscending(
        _ left: V2WorkspaceEntry,
        _ right: V2WorkspaceEntry
    ) -> Bool {
        if left.isDirectory != right.isDirectory {
            return left.isDirectory
        }
        return left.name.localizedCompare(right.name) == .orderedAscending
    }
}
