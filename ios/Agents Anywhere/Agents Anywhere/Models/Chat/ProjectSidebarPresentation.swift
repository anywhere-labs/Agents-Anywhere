import Foundation

enum ProjectSidebarPresentation {
    static func visible(_ project: V2Project, filter: V2DeviceSessionFilter) -> Bool {
        if project.manuallyCreated { return true }
        switch filter {
        case .active: return project.sidebarSessionCounts.active > 0
        case .archived: return project.sidebarSessionCounts.archived > 0
        case .all: return project.sidebarSessionCounts.active + project.sidebarSessionCounts.archived > 0
        }
    }
    static func sessions(_ values: [V2SessionMeta], projectID: String?, filter: V2DeviceSessionFilter) -> [V2SessionMeta] {
        values.filter { value in
            guard projectID == nil || value.projectId == projectID else { return false }
            switch filter {
            case .active: return !value.archived && !value.pinned
            case .archived: return value.archived
            case .all: return value.archived || !value.pinned
            }
        }.sorted { SessionSidebarPresentation($0).precedes(SessionSidebarPresentation($1), id: $0.id, otherID: $1.id) }
    }
    static func projects(_ values: [V2Project], filter: V2DeviceSessionFilter) -> [V2Project] {
        values.filter { visible($0, filter: filter) }.sorted {
            if $0.pinned != $1.pinned { return $0.pinned }
            if $0.pinned {
                if $0.pinnedAt != $1.pinnedAt { return ($0.pinnedAt ?? "") > ($1.pinnedAt ?? "") }
                if $0.lastActivityAt != $1.lastActivityAt { return ($0.lastActivityAt ?? "") > ($1.lastActivityAt ?? "") }
            } else if $0.createdAt != $1.createdAt { return $0.createdAt > $1.createdAt }
            return ($0.name, $0.id) < ($1.name, $1.id)
        }
    }
}
