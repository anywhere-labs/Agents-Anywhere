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
    var runtime: String? = nil
    var runtimeId: String? = nil
    var nativeProjectId: String? = nil
    var identityKind: String? = nil
    var roots: [String]? = nil
    var sourceState: String? = nil
    var sourceAvailability: String? = nil
    var rootStates: [String: String]? = nil
    var preferredWorkspacePath: String { roots?.first(where: { rootStates?[$0] == "present" }) ?? workspacePath }
    var lastSyncedAt: String? = nil
}

nonisolated struct V2ProjectSessionCounts: Codable, Hashable {
    let active: Int
    let archived: Int
}

nonisolated struct V2ProjectListResponse: Decodable { let projects: [V2Project]; let serverTime: String }
nonisolated struct V2ProjectResponse: Decodable { let project: V2Project; let serverTime: String }
nonisolated struct V2ProjectDeleteResponse: Decodable { let projectId: String; let detachedSessions: Int }
nonisolated struct V2ProjectCreateRequest: Codable {
    let name: String
    let connectorId: V2ConnectorID
    let workspacePath: String
    var runtime: String? = nil
    var runtimeId: String? = nil
    var newOperation: Bool = false
    var requestId: String = UUID().uuidString
}
nonisolated struct V2ProjectOperation: Decodable {
    let project: V2Project?
    let operationId: String
    let status: String
    let syncState: String
    let nativeProjectId: String?
    let roots: [String]
    let message: String?
    let serverTime: String
}
nonisolated struct V2PendingProjectOperation: Decodable, Identifiable {
    let request: V2ProjectCreateRequest
    let operation: V2ProjectOperation
    var id: String { operation.operationId }
}
nonisolated struct V2ProjectOperationList: Decodable { let operations: [V2PendingProjectOperation] }
nonisolated struct V2ProjectPatchRequest: Encodable { let name: String?; let pinned: Bool? }

nonisolated struct V2SessionPageInfo: Codable, Hashable {
    var hasMore = false
    var nextCursor: String? = nil
}
nonisolated struct V2DashboardSessionPages: Codable, Hashable {
    var active = V2SessionPageInfo()
    var archived = V2SessionPageInfo()
}

/// Each list keeps its own cursor; a project page is not a slice of the global page.
nonisolated struct V2SessionListScope: Codable, Hashable {
    var projectID: String? = nil
    var archived = false
}
