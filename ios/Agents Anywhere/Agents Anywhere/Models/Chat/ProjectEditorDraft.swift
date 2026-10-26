import Foundation

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
