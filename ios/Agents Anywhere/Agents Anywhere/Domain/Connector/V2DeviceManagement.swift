import Foundation

struct V2DeviceWorkspace: Identifiable, Hashable {
    let path: String
    let name: String
    let sessionCount: Int
    let lastActiveAt: String?

    var id: String { path }
}

enum V2DeviceSessionFilter: String, CaseIterable, Identifiable, Hashable {
    case active
    case archived
    case all

    var id: String { rawValue }

    var title: LocalizedStringResource {
        switch self {
        case .active: "Active"
        case .archived: "Archived"
        case .all: "All"
        }
    }

    var archiveScope: V2ConnectorSessionArchiveScope {
        switch self {
        case .active: .active
        case .archived: .archived
        case .all: .all
        }
    }
}

enum V2DeviceProjection {
    static func sessions(
        connectorId: V2ConnectorID,
        allSessions: [V2SessionMeta]
    ) -> [V2SessionMeta] {
        allSessions.filter { $0.connectorId == connectorId }
    }

    static func workspaces(sessions: [V2SessionMeta]) -> [V2DeviceWorkspace] {
        struct Aggregate {
            let path: String
            var sessionCount: Int
            var lastActiveAt: String?
        }

        var aggregates: [String: Aggregate] = [:]
        for session in sessions {
            let path = session.cwd ?? "~"
            let activity = session.sortAt ?? session.lastActivityAt ?? session.lastItemAt
            var aggregate = aggregates[path] ?? Aggregate(
                path: path,
                sessionCount: 0,
                lastActiveAt: nil
            )
            aggregate.sessionCount += 1
            if (aggregate.lastActiveAt ?? "") < (activity ?? "") {
                aggregate.lastActiveAt = activity
            }
            aggregates[path] = aggregate
        }

        return aggregates.values
            .map { aggregate in
                V2DeviceWorkspace(
                    path: aggregate.path,
                    name: workspaceName(path: aggregate.path),
                    sessionCount: aggregate.sessionCount,
                    lastActiveAt: aggregate.lastActiveAt
                )
            }
            .sorted { left, right in
                if left.lastActiveAt != right.lastActiveAt {
                    return (left.lastActiveAt ?? "") > (right.lastActiveAt ?? "")
                }
                return left.name.localizedStandardCompare(right.name) == .orderedAscending
            }
    }

    private static func workspaceName(path: String) -> String {
        path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
    }
}
