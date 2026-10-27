import Foundation

nonisolated struct V2ModelCatalogResponse: Decodable, Hashable {
    let catalog: V2ModelCatalog
    let serverTime: String
}

nonisolated struct V2ModelCatalog: Decodable, Hashable {
    let runtime: V2RuntimeID
    let revision: Int
    let models: [V2ModelCatalogItem]
}

nonisolated struct V2ModelCatalogItem: Decodable, Identifiable, Hashable {
    let enabled: Bool?
    let disabledReason: String?
    let displayName: String
    let id: String
    let selectionId: V2SelectionID?
    let description: String?
    let `default`: Bool
    let reasoningItems: [V2ReasoningCatalogItem]
    let metadata: JSONValue
    /// Provider or relay that routes the model; null for Codex and Claude.
    let group: V2ModelGroup?
}

nonisolated struct V2ModelGroup: Decodable, Hashable {
    let id: String
    let displayName: String
    /// Row text under this group's header, without the provider the header shows.
    let itemDisplayName: String?
}

nonisolated struct V2ReasoningCatalogItem: Decodable, Identifiable, Hashable {
    let enabled: Bool?
    let disabledReason: String?
    let displayName: String
    let id: String
    let fullModelId: String?
    let selectionId: V2SelectionID
    let description: String?
    let `default`: Bool
    let metadata: JSONValue
}

nonisolated struct V2PermissionCatalogResponse: Decodable, Hashable {
    let catalog: V2PermissionCatalog
    let serverTime: String
}

nonisolated struct V2PermissionCatalog: Decodable, Hashable {
    let runtime: V2RuntimeID
    let revision: Int
    let permissions: [V2PermissionCatalogItem]
}

nonisolated struct V2PermissionCatalogItem: Decodable, Identifiable, Hashable {
    let enabled: Bool?
    let disabledReason: String?
    let displayName: String
    let id: String
    let selectionId: V2SelectionID
    let description: String?
    let `default`: Bool
    let metadata: JSONValue
}
