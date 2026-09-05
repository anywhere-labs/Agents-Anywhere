import Foundation
import Observation

struct CatalogOption: Identifiable, Equatable {
    let id: String
    let title: String
    var detail = ""
    var selectionID: String?
    var isDefault = false
    var isEnabled = true
    var disabledReason: String?
}

struct ChatModelOption: Identifiable, Equatable {
    let option: CatalogOption
    var reasoning: [CatalogOption] = []
    var id: String { option.id }
}

struct ChatSettingsCatalog: Equatable {
    var models: [ChatModelOption] = []
    var permissions: [CatalogOption] = []

    init() {}
    init(_ value: V2SessionCatalogs) {
        models = value.model.models.map { model in
            ChatModelOption(option: Self.option(id: model.id, title: model.displayName,
                detail: model.description, selection: model.selectionId, isDefault: model.default,
                enabled: model.enabled, reason: model.disabledReason, metadata: model.metadata),
                reasoning: model.reasoningItems.map { item in
                    Self.option(id: item.id, title: item.displayName, detail: item.description,
                        selection: item.selectionId, isDefault: item.default,
                        enabled: item.enabled, reason: item.disabledReason, metadata: item.metadata)
                })
        }
        permissions = value.permission.permissions.map { item in
            Self.option(id: item.id, title: item.displayName, detail: item.description,
                selection: item.selectionId, isDefault: item.default,
                enabled: item.enabled, reason: item.disabledReason, metadata: item.metadata)
        }
    }

    private static func option(id: String, title: String, detail: String?, selection: String?,
                               isDefault: Bool, enabled: Bool?, reason: String?, metadata: JSONValue) -> CatalogOption {
        CatalogOption(id: id, title: title, detail: detail ?? "", selectionID: selection,
            isDefault: isDefault, isEnabled: enabled ?? metadata["enabled"]?.boolValue ?? true,
            disabledReason: reason ?? metadata["disabledReason"]?.stringValue)
    }
}

/// Catalog IDs label UI choices; only opaque selection IDs cross the API boundary.
@MainActor @Observable
final class ConversationSettings {
    private(set) var catalog = ChatSettingsCatalog()
    private(set) var modelID = ""
    private(set) var reasoningID = ""
    private(set) var permissionID = ""

    var model: ChatModelOption? { catalog.models.first { $0.id == modelID } }
    var reasoning: CatalogOption? { model?.reasoning.first { $0.id == reasoningID } }
    var permission: CatalogOption? { catalog.permissions.first { $0.id == permissionID } }
    var modelLabel: String {
        let parts = [model?.option.title, reasoning?.title].compactMap { $0 }
        return parts.isEmpty ? "默认模型" : parts.joined(separator: " · ")
    }
    var selections: [V2RuntimeSelectionScope: V2SelectionID] {
        var result: [V2RuntimeSelectionScope: V2SelectionID] = [:]
        result[.model] = reasoning?.selectionID ?? model?.option.selectionID
        result[.permission] = permission?.selectionID
        return result
    }
    var hasValidSelections: Bool {
        (catalog.models.isEmpty || selections[.model] != nil)
            && (catalog.permissions.isEmpty || selections[.permission] != nil)
    }

    func replace(_ catalog: ChatSettingsCatalog, selections: [V2RuntimeSelectionScope: V2SelectionID] = [:], defaults: Bool = true) {
        self.catalog = catalog
        modelID = ""; reasoningID = ""; permissionID = ""
        let selection = selections[.model]
        for model in catalog.models where model.option.isEnabled {
            if let selection, model.option.selectionID == selection {
                modelID = model.id; break
            }
            if let selection, let reasoning = model.reasoning.first(where: { $0.isEnabled && $0.selectionID == selection }) {
                modelID = model.id; reasoningID = reasoning.id; break
            }
        }
        if modelID.isEmpty, defaults,
           let model = catalog.models.first(where: { $0.option.isDefault && $0.option.isEnabled })
               ?? catalog.models.first(where: { $0.option.isEnabled }) {
            _ = selectModel(model.id)
        }
        permissionID = catalog.permissions.first { $0.isEnabled && $0.selectionID == selections[.permission] }?.id ?? ""
        if permissionID.isEmpty, defaults {
            permissionID = catalog.permissions.first { $0.isDefault && $0.isEnabled }?.id
                ?? catalog.permissions.first { $0.isEnabled }?.id ?? ""
        }
    }

    @discardableResult func selectModel(_ id: String, reasoning reasoningID: String = "") -> Bool {
        guard let model = catalog.models.first(where: { $0.id == id && $0.option.isEnabled }) else { return false }
        let chosen = reasoningID.isEmpty
            ? model.reasoning.first(where: { $0.isDefault && $0.isEnabled }) ?? model.reasoning.first(where: { $0.isEnabled })
            : model.reasoning.first(where: { $0.id == reasoningID && $0.isEnabled })
        guard reasoningID.isEmpty || chosen != nil,
              model.option.selectionID != nil || chosen?.selectionID != nil else { return false }
        modelID = id; self.reasoningID = chosen?.id ?? ""
        return true
    }

    @discardableResult func selectPermission(_ id: String) -> Bool {
        guard catalog.permissions.contains(where: { $0.id == id && $0.isEnabled && $0.selectionID != nil }) else { return false }
        permissionID = id
        return true
    }
}

extension V2RuntimeCapabilitySnapshot {
    func allows(_ id: V2CapabilityID) -> Bool {
        guard let value = capability(id: id) else { return false }
        return value.supported && value.available && value.allowed
    }
}

extension JSONValue {
    var boolValue: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }
}
