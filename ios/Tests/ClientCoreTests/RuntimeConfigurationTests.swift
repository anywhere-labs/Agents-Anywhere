import Foundation
import Testing
@testable import ClientCore

@Suite @MainActor struct RuntimeConfigurationTests {
    private func schema(named: Bool = false) throws -> V2RuntimeConfigSchema {
        let url = Bundle.module.url(forResource: "codex-config-schema", withExtension: "json", subdirectory: "Fixtures")!
        let source = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        return try .init(schema: source, uiSchema: .object([
            "order": .array(["useSystemCodex", "codexExecutablePath", "codexHome", "modelGateway", "environment", "customModels"].map(JSONValue.string)),
            "modelGateway": .object(["component": .string("modelGateway")]),
            "environment": .object(["component": .string("keyValue")]),
            "customModels": .object(["component": .string("customModels")]),
            "requiredForNamedInstance": .array([.string("codexHome")]),
        ]), defaults: ["useSystemCodex": .bool(true), "environment": .object([:]), "customModels": .array([])], requiresNamedInstance: named)
    }

    @Test func realSchemaUsesStructuredEditorsAndWebTranslationKeys() throws {
        let value = try schema()
        #expect(value.fields.map(\.id) == ["useSystemCodex", "codexExecutablePath", "codexHome", "modelGateway", "environment", "customModels"])
        #expect(value.fields[3].kind == .modelGateway)
        #expect(value.fields[4].kind == .keyValue)
        #expect(value.fields[5].kind == .customModels)
        #expect(value.fields[0].translationKey("labelKey")?.hasPrefix("dashboard.device.runtimeConfigFields.") == true)
        #expect(try value.forNamedInstance().fields.first { $0.id == "codexHome" }?.isRequired == true)
    }

    @Test func gatewayCanBeOmittedButIncompleteOrMalformedGatewaysFail() throws {
        let draft = RuntimeConfigurationModel(schema: try schema(), config: nil)
        #expect(try draft.makeConfig()["modelGateway"] == nil)
        draft.gateways["modelGateway"] = .init(baseURL: "https://gateway.example/v1", apiKey: "secret")
        #expect(try draft.makeConfig()["modelGateway"] == .object(["baseUrl": .string("https://gateway.example/v1"), "apiKey": .string("secret")]))
        draft.gateways["modelGateway"]?.apiKey = ""
        #expect(throws: RuntimeConfigurationValidationError.self) { try draft.makeConfig() }
        #expect(draft.errors["modelGateway"] != nil)
        #expect(draft.gateways["modelGateway"]?.baseURL == "https://gateway.example/v1")
        draft.gateways["modelGateway"] = .init(baseURL: "file:///tmp/gateway", apiKey: "secret")
        #expect(throws: RuntimeConfigurationValidationError.self) { try draft.makeConfig() }
        draft.gateways["modelGateway"] = .init()
        #expect(try draft.makeConfig()["modelGateway"] == nil)
    }

    @Test func environmentRetainsUnsetEmptyAndEqualsWithoutTextParsing() throws {
        let config: JSONValue = .object(["environment": .object(["UNSET": .null, "EMPTY": .string(""), "TOKEN": .string("a=b=c")]), "futureField": .number(12)])
        let draft = RuntimeConfigurationModel(schema: try schema(), config: config)
        let value = try draft.makeConfig()
        #expect(value["environment"] == config["environment"])
        #expect(value["futureField"] == .number(12))
        draft.environments["environment"]?.append(.init(key: " TOKEN ", value: "duplicate"))
        #expect(throws: RuntimeConfigurationValidationError.self) { try draft.makeConfig() }
        #expect(draft.environments["environment"]?.count == 4)
    }

    @Test func customModelsPreserveEffortsAndRejectDuplicatesOrMissingNames() throws {
        let draft = RuntimeConfigurationModel(schema: try schema(), config: nil)
        let model = RuntimeCustomModelRow(modelID: " model-one ", displayName: "Model One", efforts: [.init(effortID: "high", displayName: "High")])
        draft.customModels["customModels"] = [model, .init()]
        let result = try draft.makeConfig()["customModels"]?.configArray
        #expect(result?.count == 1)
        #expect(result?.first?["modelId"] == .string("model-one"))
        #expect(result?.first?["efforts"]?.configArray?.count == 1)
        draft.customModels["customModels"] = [model, model]
        #expect(throws: RuntimeConfigurationValidationError.self) { try draft.makeConfig() }
        draft.customModels["customModels"] = [.init(modelID: "id")]
        #expect(throws: RuntimeConfigurationValidationError.self) { try draft.makeConfig() }
        draft.customModels["customModels"] = [.init(modelID: "id", displayName: "Name", efforts: [.init(effortID: "low", displayName: "Low"), .init(effortID: "low", displayName: "Low")])]
        #expect(throws: RuntimeConfigurationValidationError.self) { try draft.makeConfig() }
    }

    @Test func resetPreservesOnlyNamedInstanceRequiredConfiguration() throws {
        let original: JSONValue = .object(["codexHome": .string("/work/codex"), "useSystemCodex": .bool(false)])
        let named = RuntimeConfigurationModel(schema: try schema(named: true), config: original)
        named.textValues["codexHome"] = "/edited"
        named.resetDefaults()
        #expect(named.textValues["codexHome"] == "/work/codex")
        #expect(try named.makeConfig()["useSystemCodex"] == .bool(true))
        let basic = RuntimeConfigurationModel(schema: try schema(), config: original)
        basic.resetDefaults()
        #expect(try basic.makeConfig()["codexHome"] == nil)
    }

    @Test func deviceSelectionCannotEscapeCurrentConnectorOrProject() throws {
        var first = try snapshot().session
        first.projectId = "a"
        var second = try snapshot(id: "second").session
        second.projectId = "b"
        let model = DeviceManagementModel()
        model.updateSessions(connectorId: first.connectorId, allSessions: [first, second])
        model.selectProject("a")
        model.toggleSessionSelection(second.id)
        #expect(model.selectedSessionIds.isEmpty)
        model.toggleSelectAll()
        #expect(model.selectedSessionIds == [first.id])
        model.selectProject("b")
        #expect(model.selectedSessionIds.isEmpty)
        model.toggleSelectAll()
        model.updateSessions(connectorId: "different-device", allSessions: [first, second])
        #expect(model.sessions.isEmpty && model.selectedSessionIds.isEmpty)
    }
}
