import Foundation

/// Serial, bounded disk I/O off the main actor. Account invalidation closes this
/// handle before deleting it, so an in-flight save cannot recreate signed-out data.
actor V2LocalStore {
    private struct Envelope<Value: Codable>: Codable { let version: Int; let value: Value }
    private let directory: URL
    private var valid = true
    private var removedSessions: Set<String> = []
    private let maximumSessions: Int

    init(directory: URL, maximumSessions: Int = 8) { self.directory = directory; self.maximumSessions = maximumSessions }
    func dashboard() -> V2DashboardArchive? { read("dashboard", as: V2DashboardArchive.self) }
    func session(_ id: String) -> V2SessionArchive? { read(sessionKey(id), as: V2SessionArchive.self) }
    func saveDashboard(_ value: V2DashboardArchive) { write(value, key: "dashboard") }
    func saveSession(_ value: V2SessionArchive) { guard !removedSessions.contains(value.session.id) else { return }; write(value, key: sessionKey(value.session.id)); trim() }
    func removeSession(_ id: String) { removedSessions.insert(id); try? FileManager.default.removeItem(at: url(sessionKey(id))) }
    func close(removing: Bool) {
        valid = false
        if removing { try? FileManager.default.removeItem(at: directory) }
    }
    private func read<Value: Codable>(_ key: String, as: Value.Type) -> Value? {
        guard valid else { return nil }
        let location = url(key)
        guard let size = try? location.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 64 * 1024 * 1024,
              let bytes = try? Data(contentsOf: location),
              let envelope = try? JSONDecoder().decode(Envelope<Value>.self, from: bytes), envelope.version == 1 else { return nil }
        return envelope.value
    }
    private func write<Value: Codable>(_ value: Value, key: String) {
        guard valid, let bytes = try? JSONEncoder().encode(Envelope(version: 1, value: value)), bytes.count <= 64 * 1024 * 1024 else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var folder = directory; var values = URLResourceValues(); values.isExcludedFromBackup = true
            try folder.setResourceValues(values)
            #if os(iOS)
            try bytes.write(to: url(key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            #else
            try bytes.write(to: url(key), options: .atomic)
            #endif
        } catch { /* A full/unavailable disk must not prevent reading or sending. */ }
    }
    private func trim() {
        guard let files = try? FileManager.default.contentsOfDirectory(at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey]) else { return }
        let sessions = files.filter { $0.lastPathComponent.hasPrefix("session-") }.sorted {
            (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                > (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        }
        var bytes = 0
        for (index, file) in sessions.enumerated() {
            bytes += (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            if index >= maximumSessions || bytes > 128 * 1024 * 1024 { try? FileManager.default.removeItem(at: file) }
        }
    }
    private func sessionKey(_ id: String) -> String { "session-" + V2RestorationStore.digest(id) }
    private func url(_ key: String) -> URL { directory.appendingPathComponent(key + ".json") }
}
