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
    var group: V2ModelGroup?
    var id: String { option.id }
}

/// One block of the model picker; `title` is nil for a headerless section.
struct ChatModelSection: Identifiable, Equatable {
    let id: String?
    let title: String?
    let models: [ChatModelOption]

    /// Row text in this section. Under a provider header the row drops the provider the
    /// header already shows; flat lists and the selected-model label keep the catalog name,
    /// which stays unique on its own.
    func rowTitle(_ model: ChatModelOption) -> String {
        guard title != nil else { return model.option.title }
        return model.group?.itemDisplayName ?? model.option.title
    }
}

struct ChatSettingsCatalog: Equatable {
    var models: [ChatModelOption] = []
    var permissions: [CatalogOption] = []

    /// Provider sections in first-appearance order of `group.id`, catalog order within each.
    /// With fewer than two distinct groups the list stays flat; otherwise ungrouped models
    /// trail in a final headerless section. Same rule as Web, Desktop and Android.
    var modelSections: [ChatModelSection] {
        guard !models.isEmpty else { return [] }
        var order: [String] = []
        var titles: [String: String] = [:]
        var grouped: [String: [ChatModelOption]] = [:]
        var ungrouped: [ChatModelOption] = []
        for model in models {
            guard let group = model.group else { ungrouped.append(model); continue }
            if grouped[group.id] == nil {
                order.append(group.id)
                titles[group.id] = group.displayName
            }
            grouped[group.id, default: []].append(model)
        }
        guard order.count >= 2 else { return [ChatModelSection(id: nil, title: nil, models: models)] }
        var sections = order.map { ChatModelSection(id: $0, title: titles[$0], models: grouped[$0] ?? []) }
        if !ungrouped.isEmpty { sections.append(ChatModelSection(id: nil, title: nil, models: ungrouped)) }
        return sections
    }

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
                },
                group: model.group)
        }
        permissions = value.permission.permissions.map { item in
            Self.option(id: item.id, title: item.displayName, detail: item.description,
                selection: item.selectionId, isDefault: item.default,
                enabled: item.enabled, reason: item.disabledReason, metadata: item.metadata)
        }
    }

    private static func option(id: String, title: String, detail: String?, selection: String?,
                               isDefault: Bool, enabled: Bool?, reason: String?, metadata: JSONValue) -> CatalogOption {
        CatalogOption(id: id, title: RuntimeLocalizedCopy.text(title, metadata: metadata),
            detail: RuntimeLocalizedCopy.text(detail ?? "", metadata: metadata, field: "descriptionKey"), selectionID: selection,
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
    private(set) var defaultScopes: Set<V2RuntimeSelectionScope> = []

    var model: ChatModelOption? { catalog.models.first { $0.id == modelID } }
    var reasoning: CatalogOption? { model?.reasoning.first { $0.id == reasoningID } }
    var permission: CatalogOption? { catalog.permissions.first { $0.id == permissionID } }
    var modelLabel: String {
        let parts = [model?.option.title, reasoning?.title].compactMap { $0 }
        if !parts.isEmpty { return parts.joined(separator: " · ") }
        if defaultScopes.contains(.model) { return String(localized: "Runtime 默认值") }
        return String(localized: "模型未同步")
    }
    var permissionLabel: String {
        if let permission { return permission.title }
        if defaultScopes.contains(.permission) { return String(localized: "Runtime 默认值") }
        return String(localized: "权限未同步")
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
        replaceCatalog(catalog, selections: selections.mapValues { .some($0) }, defaults: defaults)
    }

    func replaceRuntime(
        _ catalog: ChatSettingsCatalog,
        selections: [V2RuntimeSelectionScope: V2SelectionID?]
    ) {
        replaceCatalog(catalog, selections: selections, defaults: false)
    }

    private func replaceCatalog(
        _ catalog: ChatSettingsCatalog,
        selections: [V2RuntimeSelectionScope: V2SelectionID?],
        defaults: Bool
    ) {
        self.catalog = catalog
        modelID = ""; reasoningID = ""; permissionID = ""
        defaultScopes = Set(selections.compactMap { scope, value in value == nil ? scope : nil })
        let selection = selections[.model] ?? nil
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
        let permissionSelection = selections[.permission] ?? nil
        permissionID = catalog.permissions.first { $0.isEnabled && $0.selectionID == permissionSelection }?.id ?? ""
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
