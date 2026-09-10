import Foundation

enum ProjectSidebarPresentation {
    static func visible(_ project: V2Project, filter: V2DeviceSessionFilter, sessions: [V2SessionMeta] = []) -> Bool {
        if project.manuallyCreated { return true }
        return sessions.contains { $0.projectId == project.id && matches($0, filter: filter) }
    }
    private static func matches(_ session: V2SessionMeta, filter: V2DeviceSessionFilter) -> Bool {
        switch filter {
        case .active: !session.archived && !session.pinned
        case .archived: session.archived
        case .all: session.archived || !session.pinned
        }
    }
    static func sessions(_ values: [V2SessionMeta], projectID: String?, filter: V2DeviceSessionFilter) -> [V2SessionMeta] {
        values.filter { value in
            guard projectID == nil || value.projectId == projectID else { return false }
            return matches(value, filter: filter)
        }.sorted { SessionSidebarPresentation($0).precedes(SessionSidebarPresentation($1), id: $0.id, otherID: $1.id) }
    }
    static func unassignedSessions(_ values: [V2SessionMeta], projects: [V2Project], filter: V2DeviceSessionFilter) -> [V2SessionMeta] {
        let projectIDs = Set(projects.map(\.id))
        return sessions(values, projectID: nil, filter: filter).filter {
            $0.projectId.map { !projectIDs.contains($0) } ?? true
        }
    }
    static func projects(_ values: [V2Project], filter: V2DeviceSessionFilter, sessions: [V2SessionMeta] = []) -> [V2Project] {
        var activity: [String: TimeInterval] = [:]
        for session in sessions {
            guard let id = session.projectId else { continue }
            let time = [session.sortAt, session.lastActivityAt, session.createdAt].compactMap { $0 }.first { !$0.isEmpty }
            activity[id] = max(activity[id] ?? 0, timestamp(time))
        }
        let order = Dictionary(uniqueKeysWithValues: values.map { project in
            let empty = project.manuallyCreated && (project.lastActivityAt?.isEmpty ?? true) && activity[project.id] == nil
                && project.activeSessionCount == 0 && project.sidebarSessionCounts.active == 0 && project.sidebarSessionCounts.archived == 0
            return (project.id, (empty: empty, activity: max(timestamp(project.lastActivityAt), activity[project.id] ?? 0), created: timestamp(project.createdAt)))
        })
        return values.filter { visible($0, filter: filter, sessions: sessions) }.sorted {
            if $0.pinned != $1.pinned { return $0.pinned }
            let left = order[$0.id]!, right = order[$1.id]!
            if left.empty != right.empty { return left.empty }
            if left.activity != right.activity { return left.activity > right.activity }
            if left.created != right.created { return left.created > right.created }
            let names = $0.name.localizedStandardCompare($1.name)
            return names == .orderedSame ? $0.id < $1.id : names == .orderedAscending
        }
    }

    private static func timestamp(_ value: String?) -> TimeInterval {
        guard let value else { return 0 }
        return ((try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value))
            ?? (try? Date.ISO8601FormatStyle().parse(value)))?.timeIntervalSince1970 ?? 0
    }
}
