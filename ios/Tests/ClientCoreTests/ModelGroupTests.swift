import Foundation
import Testing
@testable import ClientCore

/// Model picker sections follow the cross-client rule in docs/api/capabilities.md.
@Suite @MainActor struct ModelGroupTests {
    private func sharedCatalog(_ name: String) throws -> V2ModelCatalog {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("contracts/protocol/1.0/fixtures/valid/model-catalog/\(name).json")
        return try JSONDecoder().decode(V2ModelCatalog.self, from: Data(contentsOf: url))
    }

    private func catalog(_ model: V2ModelCatalog) throws -> ChatSettingsCatalog {
        let permission: V2PermissionCatalogResponse = try fixture("permissionCatalog")
        return ChatSettingsCatalog(V2SessionCatalogs(model: model, permission: permission.catalog))
    }

    private func model(_ id: String, group: String? = nil, header: String? = nil, row: String? = nil) -> ChatModelOption {
        ChatModelOption(option: CatalogOption(id: id, title: "\(id) title"),
                        group: group.map { V2ModelGroup(id: $0, displayName: header ?? $0, itemDisplayName: row) })
    }

    @Test func sharedProviderFixtureSectionsByProviderWithShortRowTitles() throws {
        let catalog = try catalog(sharedCatalog("provider-groups"))
        let sections = catalog.modelSections
        #expect(sections.map(\.title) == ["DeepSeek", "Relay A"])
        #expect(sections.map { $0.models.map(\.id) } == [
            ["deepseek/deepseek-v4", "deepseek/deepseek-v4-flash"], ["relay-a/deepseek-v4"],
        ])
        #expect(sections.map { section in section.models.map(section.rowTitle) } == [
            ["deepseek-v4", "deepseek-v4-flash"], ["deepseek-v4"],
        ])
        let settings = ConversationSettings()
        settings.replace(catalog, selections: [.model: "dsh:model:WyJyZWxheS1hIiwiZGVlcHNlZWstdjQiLG51bGxd"])
        #expect(settings.modelID == "relay-a/deepseek-v4")
        #expect(settings.modelLabel == "deepseek-v4（Relay A）")
    }

    @Test func catalogsWithoutGroupsDecodeAndStayFlat() throws {
        let plain: V2ModelCatalogResponse = try fixture("modelCatalog")
        let catalog = try catalog(plain.catalog)
        #expect(catalog.models.allSatisfy { $0.group == nil })
        let sections = catalog.modelSections
        #expect(sections.count == 1 && sections[0].title == nil)
        #expect(sections[0].models.map { sections[0].rowTitle($0) } == catalog.models.map(\.option.title))
        var object = try fixtureObject("modelCatalog")
        var body = object["catalog"] as! [String: Any]
        var models = body["models"] as! [[String: Any]]
        models[0]["group"] = NSNull()
        body["models"] = models; object["catalog"] = body
        let explicitNull: V2ModelCatalogResponse = try decode(object)
        #expect(explicitNull.catalog.models[0].group == nil)
    }

    @Test func oneDistinctGroupKeepsTheFlatListAndCatalogNames() {
        var catalog = ChatSettingsCatalog()
        catalog.models = [model("a", group: "p", row: "short a"), model("b"), model("c", group: "p")]
        let sections = catalog.modelSections
        #expect(sections.count == 1 && sections[0].id == nil && sections[0].title == nil)
        #expect(sections[0].models.map(\.id) == ["a", "b", "c"])
        #expect(sections[0].rowTitle(catalog.models[0]) == "a title")
    }

    @Test func groupsFollowFirstAppearanceAndUngroupedTrail() {
        var catalog = ChatSettingsCatalog()
        catalog.models = [
            model("free"),
            model("b1", group: "b", header: "Bee", row: "one"),
            model("a1", group: "a", header: "Ay"),
            model("b2", group: "b", header: "Renamed later", row: "two"),
            model("free2"),
        ]
        let sections = catalog.modelSections
        #expect(sections.map(\.id) == ["b", "a", nil])
        #expect(sections.map(\.title) == ["Bee", "Ay", nil])
        #expect(sections.map { $0.models.map(\.id) } == [["b1", "b2"], ["a1"], ["free", "free2"]])
        #expect(sections[0].models.map(sections[0].rowTitle) == ["one", "two"])
        #expect(sections[1].rowTitle(sections[1].models[0]) == "a1 title")
        #expect(sections[2].rowTitle(sections[2].models[0]) == "free title")
        #expect(ChatSettingsCatalog().modelSections.isEmpty)
    }
}
