import Foundation

struct V2ModelCatalogResponse: Decodable, Hashable {
    let catalog: V2ModelCatalog
    let serverTime: String
}

struct V2ModelCatalog: Decodable, Hashable {
    let runtime: V2RuntimeID
    let revision: Int
    let models: [V2ModelCatalogItem]
}

struct V2ModelCatalogItem: Decodable, Identifiable, Hashable {
    let displayName: String
    let id: String
    let selectionId: V2SelectionID?
    let description: String?
    let `default`: Bool
    let reasoningItems: [V2ReasoningCatalogItem]
    let metadata: JSONValue
}

struct V2ReasoningCatalogItem: Decodable, Identifiable, Hashable {
    let displayName: String
    let id: String
    let fullModelId: String?
    let selectionId: V2SelectionID
    let description: String?
    let `default`: Bool
    let metadata: JSONValue
}

struct V2PermissionCatalogResponse: Decodable, Hashable {
    let catalog: V2PermissionCatalog
    let serverTime: String
}

struct V2PermissionCatalog: Decodable, Hashable {
    let runtime: V2RuntimeID
    let revision: Int
    let permissions: [V2PermissionCatalogItem]
}

struct V2PermissionCatalogItem: Decodable, Identifiable, Hashable {
    let displayName: String
    let id: String
    let selectionId: V2SelectionID
    let description: String?
    let `default`: Bool
    let metadata: JSONValue
}
