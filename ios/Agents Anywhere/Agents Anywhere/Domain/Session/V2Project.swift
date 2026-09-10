import Foundation

nonisolated struct V2Project: Codable, Identifiable, Hashable {
    let id: String
    let userId: String
    let connectorId: V2ConnectorID
    let name: String
    let workspacePath: String
    let manuallyCreated: Bool
    let pinned: Bool
    let pinnedAt: String?
    let activeSessionCount: Int
    let sidebarSessionCounts: V2ProjectSessionCounts
    let lastActivityAt: String?
    let createdAt: String
    let updatedAt: String
}

nonisolated struct V2ProjectSessionCounts: Codable, Hashable {
    let active: Int
    let archived: Int
}

struct V2ProjectListResponse: Decodable { let projects: [V2Project]; let serverTime: String }
struct V2ProjectResponse: Decodable { let project: V2Project; let serverTime: String }
struct V2ProjectDeleteResponse: Decodable { let projectId: String; let detachedSessions: Int }
struct V2ProjectCreateRequest: Encodable {
    let name: String
    let connectorId: V2ConnectorID
    let workspacePath: String
    var manuallyCreated = true
}
struct V2ProjectPatchRequest: Encodable { let name: String?; let pinned: Bool? }

nonisolated struct V2SessionPageInfo: Codable, Hashable {
    var hasMore = false
    var nextCursor: String? = nil
}
struct V2DashboardSessionPages: Codable, Hashable {
    var active = V2SessionPageInfo()
    var archived = V2SessionPageInfo()
}

/// Each list keeps its own cursor; a project page is not a slice of the global page.
nonisolated struct V2SessionListScope: Codable, Hashable {
    var projectID: String? = nil
    var archived = false
}
