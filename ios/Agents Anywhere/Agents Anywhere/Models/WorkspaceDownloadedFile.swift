import Foundation

/// Owns one temporary export until the system picker/activity sheet is dismissed.
/// Download bytes stay on disk rather than being loaded into the timeline cache.
nonisolated final class WorkspaceDownloadedFile: Identifiable, @unchecked Sendable {
    let url: URL
    private let directory: URL
    var id: URL { url }

    init(moving source: URL, name: String) throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("aa-file-\(UUID().uuidString)", isDirectory: true)
        let component = (name.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
            .replacingOccurrences(of: ":", with: "_")
        let safeName = component.isEmpty || [".", ".."].contains(component) ? "download" : component
        url = directory.appendingPathComponent(safeName)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        do {
            try FileManager.default.moveItem(at: source, to: url)
            #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
            #endif
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    deinit { try? FileManager.default.removeItem(at: directory) }
}
